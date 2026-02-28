'use strict';

const { parse, validate } = require('./script-parser');
const { execute } = require('./script-executor');

/**
 * Hotkey manager: CRUD for hotkey scripts, profile management,
 * and integration with the script executor.
 *
 * Stores hotkeys in SQLite via the db module.
 */

// Schema for the hotkey_scripts table — applied on first use
const HOTKEY_SCHEMA = `
CREATE TABLE IF NOT EXISTS hotkey_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  key_combo TEXT NOT NULL,
  script TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile, key_combo)
);

CREATE INDEX IF NOT EXISTS idx_hotkey_profile ON hotkey_scripts(profile);
CREATE INDEX IF NOT EXISTS idx_hotkey_key ON hotkey_scripts(key_combo);
`;

let schemaApplied = false;

function ensureSchema(db) {
  if (schemaApplied) return;
  db.exec(HOTKEY_SCHEMA);
  schemaApplied = true;
}

/**
 * Normalize a key combo string for consistent storage.
 * E.g., "ctrl+shift+a" → "Ctrl+Shift+A"
 */
function normalizeKeyCombo(combo) {
  if (!combo || typeof combo !== 'string') return '';
  return combo
    .split('+')
    .map(part => {
      const lower = part.trim().toLowerCase();
      if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
      if (lower === 'alt') return 'Alt';
      if (lower === 'shift') return 'Shift';
      if (lower === 'meta' || lower === 'cmd' || lower === 'win') return 'Meta';
      return part.trim().toUpperCase();
    })
    .join('+');
}

/**
 * Validate a key combo for reasonable format.
 */
function validateKeyCombo(combo) {
  const normalized = normalizeKeyCombo(combo);
  if (!normalized) return { valid: false, error: 'Empty key combination' };

  const parts = normalized.split('+');
  if (parts.length === 0) return { valid: false, error: 'Empty key combination' };

  // Must have at least one non-modifier key
  const modifiers = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
  const nonModifiers = parts.filter(p => !modifiers.has(p));
  if (nonModifiers.length === 0) {
    return { valid: false, error: 'Key combination must include a non-modifier key' };
  }
  if (nonModifiers.length > 1) {
    return { valid: false, error: 'Key combination can have at most one non-modifier key' };
  }

  return { valid: true, normalized };
}

/**
 * Create a new hotkey script.
 *
 * @param {object} db - Database instance (better-sqlite3)
 * @param {object} params
 * @param {string} params.name - Display name
 * @param {string} params.keyCombo - Keyboard shortcut (e.g. "Ctrl+Shift+B")
 * @param {string} params.script - Script text
 * @param {string} [params.profile='default'] - Profile name
 * @param {string} [params.description] - Optional description
 * @returns {{ id: number, errors: Array, warnings: Array }}
 */
function createHotkey(db, { name, keyCombo, script, profile = 'default', description = '' }) {
  ensureSchema(db);

  // Validate key combo
  const keyResult = validateKeyCombo(keyCombo);
  if (!keyResult.valid) {
    return { id: null, errors: [{ message: keyResult.error }], warnings: [] };
  }

  // Validate script syntax
  const { commands, errors: parseErrors } = parse(script);
  if (parseErrors.length > 0) {
    return { id: null, errors: parseErrors, warnings: [] };
  }

  const warnings = validate(commands);

  // Insert
  const result = db.prepare(`
    INSERT INTO hotkey_scripts (profile, name, key_combo, script, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(profile, name, keyResult.normalized, script, description || null);

  return { id: result.lastInsertRowid, errors: [], warnings };
}

/**
 * Update an existing hotkey script.
 */
function updateHotkey(db, id, fields) {
  ensureSchema(db);

  const allowed = new Set(['name', 'key_combo', 'script', 'profile', 'description', 'enabled']);
  const sets = [];
  const vals = [];

  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) continue;

    if (k === 'key_combo') {
      const keyResult = validateKeyCombo(v);
      if (!keyResult.valid) {
        return { success: false, errors: [{ message: keyResult.error }] };
      }
      sets.push('key_combo = ?');
      vals.push(keyResult.normalized);
    } else if (k === 'script') {
      const { errors: parseErrors } = parse(v);
      if (parseErrors.length > 0) {
        return { success: false, errors: parseErrors };
      }
      sets.push('script = ?');
      vals.push(v);
    } else {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }

  if (sets.length === 0) return { success: true, errors: [] };

  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE hotkey_scripts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  return { success: true, errors: [] };
}

/**
 * Delete a hotkey script.
 */
function deleteHotkey(db, id) {
  ensureSchema(db);
  const result = db.prepare('DELETE FROM hotkey_scripts WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Get a hotkey by ID.
 */
function getHotkey(db, id) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM hotkey_scripts WHERE id = ?').get(id);
}

/**
 * List hotkeys for a profile.
 */
function listHotkeys(db, profile = 'default') {
  ensureSchema(db);
  return db.prepare(
    'SELECT * FROM hotkey_scripts WHERE profile = ? ORDER BY name'
  ).all(profile);
}

/**
 * List all profiles.
 */
function listProfiles(db) {
  ensureSchema(db);
  return db.prepare(
    'SELECT DISTINCT profile FROM hotkey_scripts ORDER BY profile'
  ).all().map(r => r.profile);
}

/**
 * Find a hotkey by key combo in a profile.
 */
function findByKeyCombo(db, keyCombo, profile = 'default') {
  ensureSchema(db);
  const normalized = normalizeKeyCombo(keyCombo);
  return db.prepare(
    'SELECT * FROM hotkey_scripts WHERE profile = ? AND key_combo = ? AND enabled = 1'
  ).get(profile, normalized);
}

/**
 * Execute a hotkey by its key combo.
 *
 * @param {object} db - Database instance
 * @param {string} keyCombo - The key combination pressed
 * @param {object} [marketCtx] - Market data context
 * @param {string} [profile='default'] - Active profile
 * @returns {{ found: boolean, result: object|null }}
 */
function triggerHotkey(db, keyCombo, marketCtx = {}, profile = 'default') {
  const hotkey = findByKeyCombo(db, keyCombo, profile);
  if (!hotkey) {
    return { found: false, result: null };
  }

  const result = execute(hotkey.script, marketCtx);
  return {
    found: true,
    hotkey: { id: hotkey.id, name: hotkey.name, keyCombo: hotkey.key_combo },
    result,
  };
}

/**
 * Import hotkeys from a JSON array.
 */
function importHotkeys(db, hotkeys, profile = 'default') {
  ensureSchema(db);
  const results = [];

  const insertOrUpdate = db.transaction((items) => {
    for (const item of items) {
      const r = createHotkey(db, { ...item, profile });
      results.push({ name: item.name, ...r });
    }
  });

  insertOrUpdate(hotkeys);
  return results;
}

/**
 * Export hotkeys for a profile as a JSON-serializable array.
 */
function exportHotkeys(db, profile = 'default') {
  const hotkeys = listHotkeys(db, profile);
  return hotkeys.map(h => ({
    name: h.name,
    keyCombo: h.key_combo,
    script: h.script,
    description: h.description,
    enabled: h.enabled === 1,
  }));
}

module.exports = {
  createHotkey,
  updateHotkey,
  deleteHotkey,
  getHotkey,
  listHotkeys,
  listProfiles,
  findByKeyCombo,
  triggerHotkey,
  importHotkeys,
  exportHotkeys,
  normalizeKeyCombo,
  validateKeyCombo,
  ensureSchema,
};
