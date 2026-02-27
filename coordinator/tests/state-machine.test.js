'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const db = require('../src/db');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac10-test-'));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  db.init(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Request state machine', () => {
  it('should create a request in pending state', () => {
    const id = db.createRequest('Add a button');
    const req = db.getRequest(id);
    assert.strictEqual(req.status, 'pending');
    assert.strictEqual(req.description, 'Add a button');
  });

  it('should transition through triage states', () => {
    const id = db.createRequest('Fix typo');
    db.updateRequest(id, { tier: 1, status: 'executing_tier1' });
    assert.strictEqual(db.getRequest(id).status, 'executing_tier1');

    db.updateRequest(id, { status: 'completed', result: 'Fixed the typo' });
    assert.strictEqual(db.getRequest(id).status, 'completed');
  });

  it('should list requests by status', () => {
    db.createRequest('Req 1');
    const id2 = db.createRequest('Req 2');
    db.updateRequest(id2, { status: 'completed' });

    const pending = db.listRequests('pending');
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].description, 'Req 1');

    const completed = db.listRequests('completed');
    assert.strictEqual(completed.length, 1);
  });
});

describe('Task state machine', () => {
  it('should create tasks linked to requests', () => {
    const reqId = db.createRequest('Big feature');
    const taskId = db.createTask({
      request_id: reqId,
      subject: 'Add API endpoint',
      description: 'Create POST /api/items',
      domain: 'backend',
      files: ['src/api/items.js'],
      tier: 2,
    });

    const task = db.getTask(taskId);
    assert.strictEqual(task.request_id, reqId);
    assert.strictEqual(task.subject, 'Add API endpoint');
    assert.strictEqual(task.status, 'pending');
    assert.strictEqual(task.domain, 'backend');
  });

  it('should promote pending tasks with no dependencies to ready', () => {
    const reqId = db.createRequest('Feature');
    db.createTask({ request_id: reqId, subject: 'Task 1', description: 'Do thing 1' });
    db.checkAndPromoteTasks();

    const tasks = db.listTasks({ request_id: reqId });
    assert.strictEqual(tasks[0].status, 'ready');
  });

  it('should respect dependency chains', () => {
    const reqId = db.createRequest('Feature');
    const t1 = db.createTask({ request_id: reqId, subject: 'Task 1', description: 'First' });
    const t2 = db.createTask({
      request_id: reqId,
      subject: 'Task 2',
      description: 'Second',
      depends_on: [t1],
    });

    db.checkAndPromoteTasks();

    const task1 = db.getTask(t1);
    const task2 = db.getTask(t2);
    assert.strictEqual(task1.status, 'ready');
    assert.strictEqual(task2.status, 'pending'); // blocked by t1

    // Complete t1
    db.updateTask(t1, { status: 'completed' });
    db.checkAndPromoteTasks();

    const task2After = db.getTask(t2);
    assert.strictEqual(task2After.status, 'ready');
  });

  it('should prioritize urgent tasks', () => {
    const reqId = db.createRequest('Feature');
    db.createTask({ request_id: reqId, subject: 'Normal', description: 'Normal task', priority: 'normal' });
    const urgentId = db.createTask({ request_id: reqId, subject: 'Urgent', description: 'Fix now', priority: 'urgent' });

    db.checkAndPromoteTasks();
    const ready = db.getReadyTasks();
    assert.strictEqual(ready[0].id, urgentId);
    assert.strictEqual(ready[0].priority, 'urgent');
  });
});

describe('Worker state machine', () => {
  it('should register and track workers', () => {
    db.registerWorker(1, '/path/to/wt-1', 'agent-1');
    const worker = db.getWorker(1);
    assert.strictEqual(worker.status, 'idle');
    assert.strictEqual(worker.branch, 'agent-1');
  });

  it('should track worker assignment lifecycle', () => {
    db.registerWorker(1, '/path/to/wt-1', 'agent-1');
    // Create a real task for FK constraint
    const reqId = db.createRequest('Lifecycle test');
    const taskId = db.createTask({ request_id: reqId, subject: 'T', description: 'D' });

    // Assign
    db.updateWorker(1, { status: 'assigned', current_task_id: taskId });
    assert.strictEqual(db.getWorker(1).status, 'assigned');

    // Running
    db.updateWorker(1, { status: 'busy' });
    assert.strictEqual(db.getWorker(1).status, 'busy');

    // Complete
    db.updateWorker(1, { status: 'completed_task', current_task_id: null });
    assert.strictEqual(db.getWorker(1).status, 'completed_task');

    // Reset
    db.updateWorker(1, { status: 'idle' });
    assert.strictEqual(db.getWorker(1).status, 'idle');
  });

  it('should list idle workers', () => {
    db.registerWorker(1, '/wt-1', 'agent-1');
    db.registerWorker(2, '/wt-2', 'agent-2');
    db.updateWorker(2, { status: 'busy' });

    const idle = db.getIdleWorkers();
    assert.strictEqual(idle.length, 1);
    assert.strictEqual(idle[0].id, 1);
  });
});

describe('Mail system', () => {
  it('should send and receive mail', () => {
    db.sendMail('architect', 'new_request', { request_id: 'req-123' });
    const msgs = db.checkMail('architect');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].type, 'new_request');
    assert.strictEqual(msgs[0].payload.request_id, 'req-123');
  });

  it('should consume messages (read-once)', () => {
    db.sendMail('architect', 'test', { data: 1 });
    db.checkMail('architect'); // consume
    const msgs = db.checkMail('architect');
    assert.strictEqual(msgs.length, 0);
  });

  it('should support peek (non-consuming)', () => {
    db.sendMail('architect', 'test', { data: 1 });
    db.checkMail('architect', false); // peek
    const msgs = db.checkMail('architect');
    assert.strictEqual(msgs.length, 1);
  });

  it('should only return mail for specified recipient', () => {
    db.sendMail('architect', 'msg1', {});
    db.sendMail('worker-1', 'msg2', {});

    const arch = db.checkMail('architect');
    assert.strictEqual(arch.length, 1);
    assert.strictEqual(arch[0].type, 'msg1');
  });
});

describe('Activity log', () => {
  it('should log and retrieve activities', () => {
    db.log('coordinator', 'started', { version: '1.0' });
    db.log('worker-1', 'task_completed', { task_id: 1 });

    const all = db.getLog(10);
    assert.ok(all.length >= 2); // our 2 + any from createRequest/createTask internals
    // Most recent first
    assert.strictEqual(all[0].action, 'task_completed');

    const worker = db.getLog(10, 'worker-1');
    assert.strictEqual(worker.length, 1);
  });
});

describe('Config', () => {
  it('should read and write config', () => {
    db.setConfig('test_key', 'test_value');
    assert.strictEqual(db.getConfig('test_key'), 'test_value');
  });

  it('should have default config values', () => {
    assert.strictEqual(db.getConfig('max_workers'), '8');
    assert.strictEqual(db.getConfig('heartbeat_timeout_s'), '60');
  });
});
