'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let db = null;

const VALID_COLUMNS = Object.freeze({
  requests: new Set(['description', 'tier', 'status', 'result', 'completed_at']),
  tasks: new Set(['request_id', 'subject', 'description', 'domain', 'files', 'priority', 'tier', 'depends_on', 'assigned_to', 'status', 'pr_url', 'branch', 'validation', 'started_at', 'completed_at', 'result']),
  workers: new Set(['status', 'domain', 'worktree_path', 'branch', 'tmux_session', 'tmux_window', 'pid', 'current_task_id', 'last_heartbeat', 'launched_at', 'tasks_completed']),
  merge_queue: new Set(['status', 'priority', 'merged_at', 'error']),
});

function validateColumns(table, fields) {
  const allowed = VALID_COLUMNS[table];
  if (!allowed) throw new Error(`Unknown table: ${table}`);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid column "${key}" for table "${table}"`);
    }
  }
}

function getDbPath(projectDir) {
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, 'mac10.db');
}

function init(projectDir) {
  if (db) return db;
  const dbPath = getDbPath(projectDir);
  db = new Database(dbPath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  // Store project dir in config
  db.prepare('UPDATE config SET value = ? WHERE key = ?').run(projectDir, 'project_dir');
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call init(projectDir) first.');
  return db;
}

// --- Request helpers ---

function createRequest(description) {
  const id = 'req-' + crypto.randomBytes(4).toString('hex');
  getDb().prepare(`
    INSERT INTO requests (id, description) VALUES (?, ?)
  `).run(id, description);
  sendMail('architect', 'new_request', { request_id: id, description });
  log('user', 'request_created', { request_id: id, description });
  return id;
}

function getRequest(id) {
  return getDb().prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

function updateRequest(id, fields) {
  validateColumns('requests', fields);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function listRequests(status) {
  if (status) return getDb().prepare('SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC').all(status);
  return getDb().prepare('SELECT * FROM requests ORDER BY created_at DESC').all();
}

// --- Task helpers ---

function createTask({ request_id, subject, description, domain, files, priority, tier, depends_on, validation }) {
  const result = getDb().prepare(`
    INSERT INTO tasks (request_id, subject, description, domain, files, priority, tier, depends_on, validation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    request_id, subject, description,
    domain || null,
    files ? JSON.stringify(files) : null,
    priority || 'normal',
    tier || 3,
    depends_on ? JSON.stringify(depends_on) : null,
    validation ? JSON.stringify(validation) : null
  );
  log('coordinator', 'task_created', { task_id: result.lastInsertRowid, request_id, subject });
  return result.lastInsertRowid;
}

function getTask(id) {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function updateTask(id, fields) {
  validateColumns('tasks', fields);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function listTasks(filters = {}) {
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const vals = [];
  if (filters.status) { sql += ' AND status = ?'; vals.push(filters.status); }
  if (filters.request_id) { sql += ' AND request_id = ?'; vals.push(filters.request_id); }
  if (filters.assigned_to) { sql += ' AND assigned_to = ?'; vals.push(filters.assigned_to); }
  sql += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'normal\' THEN 2 WHEN \'low\' THEN 3 END, id';
  return getDb().prepare(sql).all(...vals);
}

function getReadyTasks() {
  // Tasks that are ready and have no unfinished dependencies
  return getDb().prepare(`
    SELECT * FROM tasks
    WHERE status = 'ready' AND assigned_to IS NULL
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, id
  `).all();
}

function checkAndPromoteTasks() {
  // Promote 'pending' tasks whose dependencies are all completed
  const pending = getDb().prepare("SELECT * FROM tasks WHERE status = 'pending'").all();
  for (const task of pending) {
    if (!task.depends_on) {
      updateTask(task.id, { status: 'ready' });
      continue;
    }
    const deps = JSON.parse(task.depends_on);
    const unfinished = getDb().prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND status != 'completed'`
    ).get(...deps);
    if (unfinished.cnt === 0) {
      updateTask(task.id, { status: 'ready' });
    }
  }
}

// --- Worker helpers ---

function registerWorker(id, worktreePath, branch) {
  getDb().prepare(`
    INSERT OR REPLACE INTO workers (id, worktree_path, branch, status)
    VALUES (?, ?, ?, 'idle')
  `).run(id, worktreePath, branch);
}

function getWorker(id) {
  return getDb().prepare('SELECT * FROM workers WHERE id = ?').get(id);
}

function updateWorker(id, fields) {
  validateColumns('workers', fields);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  getDb().prepare(`UPDATE workers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function getIdleWorkers() {
  return getDb().prepare("SELECT * FROM workers WHERE status = 'idle' ORDER BY id").all();
}

function getAllWorkers() {
  return getDb().prepare('SELECT * FROM workers ORDER BY id').all();
}

// --- Mail helpers ---

function sendMail(recipient, type, payload = {}) {
  getDb().prepare(`
    INSERT INTO mail (recipient, type, payload) VALUES (?, ?, ?)
  `).run(recipient, type, JSON.stringify(payload));
}

function checkMail(recipient, consume = true) {
  const messages = getDb().prepare(`
    SELECT * FROM mail WHERE recipient = ? AND consumed = 0 ORDER BY id
  `).all(recipient);
  if (consume && messages.length > 0) {
    const ids = messages.map(m => m.id);
    getDb().prepare(
      `UPDATE mail SET consumed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`
    ).run(...ids);
  }
  return messages.map(m => ({ ...m, payload: JSON.parse(m.payload) }));
}

function checkMailBlocking(recipient, timeoutMs = 300000, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = checkMail(recipient);
    if (msgs.length > 0) return msgs;
    // Sync sleep for polling (used by CLI, not coordinator)
    const waitMs = Math.min(pollMs, deadline - Date.now());
    if (waitMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  return [];
}

// --- Merge queue helpers ---

function enqueueMerge({ request_id, task_id, pr_url, branch, priority }) {
  getDb().prepare(`
    INSERT INTO merge_queue (request_id, task_id, pr_url, branch, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(request_id, task_id, pr_url, branch, priority || 0);
}

function getNextMerge() {
  return getDb().prepare(`
    SELECT * FROM merge_queue WHERE status = 'pending'
    ORDER BY priority DESC, id ASC LIMIT 1
  `).get();
}

function updateMerge(id, fields) {
  validateColumns('merge_queue', fields);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  getDb().prepare(`UPDATE merge_queue SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// --- Activity log ---

function log(actor, action, details = {}) {
  getDb().prepare(`
    INSERT INTO activity_log (actor, action, details) VALUES (?, ?, ?)
  `).run(actor, action, JSON.stringify(details));
}

function getLog(limit = 50, actor) {
  if (actor) {
    return getDb().prepare('SELECT * FROM activity_log WHERE actor = ? ORDER BY id DESC LIMIT ?').all(actor, limit);
  }
  return getDb().prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit);
}

// --- Config helpers ---

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = {
  init, close, getDb,
  createRequest, getRequest, updateRequest, listRequests,
  createTask, getTask, updateTask, listTasks, getReadyTasks, checkAndPromoteTasks,
  registerWorker, getWorker, updateWorker, getIdleWorkers, getAllWorkers,
  sendMail, checkMail, checkMailBlocking,
  enqueueMerge, getNextMerge, updateMerge,
  log, getLog,
  getConfig, setConfig,
};
