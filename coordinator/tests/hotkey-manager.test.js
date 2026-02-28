'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const {
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
} = require('../src/hotkey-manager');

let db;
let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `mac10-hotkey-test-${Date.now()}.db`);
  db = new Database(tmpFile);
  ensureSchema(db);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(tmpFile); } catch {}
});

describe('normalizeKeyCombo', () => {
  it('should normalize modifier names', () => {
    assert.strictEqual(normalizeKeyCombo('ctrl+a'), 'Ctrl+A');
    assert.strictEqual(normalizeKeyCombo('alt+b'), 'Alt+B');
    assert.strictEqual(normalizeKeyCombo('shift+c'), 'Shift+C');
  });

  it('should handle meta/cmd/win modifiers', () => {
    assert.strictEqual(normalizeKeyCombo('meta+a'), 'Meta+A');
    assert.strictEqual(normalizeKeyCombo('cmd+a'), 'Meta+A');
    assert.strictEqual(normalizeKeyCombo('win+a'), 'Meta+A');
  });

  it('should handle multi-modifier combos', () => {
    assert.strictEqual(normalizeKeyCombo('ctrl+shift+b'), 'Ctrl+Shift+B');
  });

  it('should uppercase non-modifier keys', () => {
    assert.strictEqual(normalizeKeyCombo('F1'), 'F1');
    assert.strictEqual(normalizeKeyCombo('ctrl+f5'), 'Ctrl+F5');
  });

  it('should return empty string for empty input', () => {
    assert.strictEqual(normalizeKeyCombo(''), '');
    assert.strictEqual(normalizeKeyCombo(null), '');
  });
});

describe('validateKeyCombo', () => {
  it('should accept valid key combos', () => {
    assert.ok(validateKeyCombo('Ctrl+B').valid);
    assert.ok(validateKeyCombo('Alt+F5').valid);
    assert.ok(validateKeyCombo('Ctrl+Shift+B').valid);
  });

  it('should reject modifier-only combos', () => {
    const result = validateKeyCombo('Ctrl+Shift');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('non-modifier'));
  });

  it('should reject empty combos', () => {
    const result = validateKeyCombo('');
    assert.strictEqual(result.valid, false);
  });

  it('should reject multiple non-modifier keys', () => {
    const result = validateKeyCombo('A+B');
    assert.strictEqual(result.valid, false);
  });
});

describe('createHotkey', () => {
  it('should create a hotkey with valid inputs', () => {
    const result = createHotkey(db, {
      name: 'Quick Buy',
      keyCombo: 'Ctrl+B',
      script: 'ROUTE=ARCA;Price=Ask;Share=100;BUY=Send',
    });
    assert.ok(result.id);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should reject invalid key combo', () => {
    const result = createHotkey(db, {
      name: 'Bad Hotkey',
      keyCombo: 'Ctrl+Shift',
      script: 'CXL',
    });
    assert.strictEqual(result.id, null);
    assert.ok(result.errors.length > 0);
  });

  it('should reject invalid script syntax', () => {
    const result = createHotkey(db, {
      name: 'Bad Script',
      keyCombo: 'Ctrl+B',
      script: 'FOOBAR=123',
    });
    assert.strictEqual(result.id, null);
    assert.ok(result.errors.length > 0);
  });

  it('should return validation warnings', () => {
    const result = createHotkey(db, {
      name: 'Incomplete Buy',
      keyCombo: 'Ctrl+B',
      script: 'BUY=Send',
    });
    assert.ok(result.id); // still creates it
    assert.ok(result.warnings.length > 0);
  });

  it('should reject duplicate key combos in same profile', () => {
    createHotkey(db, { name: 'First', keyCombo: 'Ctrl+B', script: 'CXL' });
    assert.throws(() => {
      createHotkey(db, { name: 'Second', keyCombo: 'Ctrl+B', script: 'PANIC' });
    }, /UNIQUE constraint/);
  });

  it('should allow same key combo in different profiles', () => {
    const r1 = createHotkey(db, { name: 'First', keyCombo: 'Ctrl+B', script: 'CXL', profile: 'profile1' });
    const r2 = createHotkey(db, { name: 'Second', keyCombo: 'Ctrl+B', script: 'PANIC', profile: 'profile2' });
    assert.ok(r1.id);
    assert.ok(r2.id);
  });
});

describe('getHotkey', () => {
  it('should retrieve a created hotkey', () => {
    const { id } = createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    const hotkey = getHotkey(db, id);
    assert.ok(hotkey);
    assert.strictEqual(hotkey.name, 'Test');
    assert.strictEqual(hotkey.key_combo, 'Ctrl+B');
    assert.strictEqual(hotkey.script, 'CXL');
  });

  it('should return undefined for non-existent id', () => {
    assert.strictEqual(getHotkey(db, 999), undefined);
  });
});

describe('updateHotkey', () => {
  it('should update hotkey name', () => {
    const { id } = createHotkey(db, { name: 'Old', keyCombo: 'Ctrl+B', script: 'CXL' });
    const result = updateHotkey(db, id, { name: 'New Name' });
    assert.ok(result.success);
    assert.strictEqual(getHotkey(db, id).name, 'New Name');
  });

  it('should validate key combo on update', () => {
    const { id } = createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    const result = updateHotkey(db, id, { key_combo: 'Ctrl+Shift' });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
  });

  it('should validate script on update', () => {
    const { id } = createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    const result = updateHotkey(db, id, { script: 'FOOBAR=123' });
    assert.strictEqual(result.success, false);
  });

  it('should update enabled status', () => {
    const { id } = createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    updateHotkey(db, id, { enabled: 0 });
    assert.strictEqual(getHotkey(db, id).enabled, 0);
  });
});

describe('deleteHotkey', () => {
  it('should delete a hotkey', () => {
    const { id } = createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    assert.ok(deleteHotkey(db, id));
    assert.strictEqual(getHotkey(db, id), undefined);
  });

  it('should return false for non-existent id', () => {
    assert.strictEqual(deleteHotkey(db, 999), false);
  });
});

describe('listHotkeys', () => {
  it('should list hotkeys for a profile', () => {
    createHotkey(db, { name: 'A', keyCombo: 'Ctrl+A', script: 'CXL' });
    createHotkey(db, { name: 'B', keyCombo: 'Ctrl+B', script: 'PANIC' });
    const list = listHotkeys(db);
    assert.strictEqual(list.length, 2);
  });

  it('should filter by profile', () => {
    createHotkey(db, { name: 'A', keyCombo: 'Ctrl+A', script: 'CXL', profile: 'p1' });
    createHotkey(db, { name: 'B', keyCombo: 'Ctrl+B', script: 'PANIC', profile: 'p2' });
    assert.strictEqual(listHotkeys(db, 'p1').length, 1);
    assert.strictEqual(listHotkeys(db, 'p2').length, 1);
  });
});

describe('listProfiles', () => {
  it('should list distinct profiles', () => {
    createHotkey(db, { name: 'A', keyCombo: 'Ctrl+A', script: 'CXL', profile: 'alpha' });
    createHotkey(db, { name: 'B', keyCombo: 'Ctrl+B', script: 'PANIC', profile: 'beta' });
    const profiles = listProfiles(db);
    assert.ok(profiles.includes('alpha'));
    assert.ok(profiles.includes('beta'));
  });
});

describe('findByKeyCombo', () => {
  it('should find a hotkey by combo', () => {
    createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    const found = findByKeyCombo(db, 'ctrl+b');
    assert.ok(found);
    assert.strictEqual(found.name, 'Test');
  });

  it('should return undefined for unbound combo', () => {
    assert.strictEqual(findByKeyCombo(db, 'Ctrl+Z'), undefined);
  });

  it('should not return disabled hotkeys', () => {
    const { id } = createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    updateHotkey(db, id, { enabled: 0 });
    assert.strictEqual(findByKeyCombo(db, 'Ctrl+B'), undefined);
  });
});

describe('triggerHotkey', () => {
  it('should execute a hotkey script', () => {
    createHotkey(db, {
      name: 'Buy 100',
      keyCombo: 'Ctrl+B',
      script: 'ROUTE=ARCA;Price=Ask+0.05;Share=100;BUY=Send',
    });
    const { found, result } = triggerHotkey(db, 'Ctrl+B', { ASK: 150.00 });
    assert.ok(found);
    assert.ok(result.success);
    assert.strictEqual(result.action.type, 'SEND_ORDER');
    assert.strictEqual(result.action.order.side, 'BUY');
    assert.strictEqual(result.action.order.price, 150.05);
  });

  it('should return found=false for unbound combo', () => {
    const { found } = triggerHotkey(db, 'Ctrl+Z');
    assert.strictEqual(found, false);
  });
});

describe('importHotkeys / exportHotkeys', () => {
  it('should import an array of hotkeys', () => {
    const hotkeys = [
      { name: 'Buy', keyCombo: 'Ctrl+B', script: 'BUY=Send' },
      { name: 'Sell', keyCombo: 'Ctrl+S', script: 'SELL=Send' },
    ];
    const results = importHotkeys(db, hotkeys);
    assert.strictEqual(results.length, 2);
    assert.ok(results[0].id);
    assert.ok(results[1].id);
  });

  it('should export hotkeys as JSON-serializable data', () => {
    createHotkey(db, { name: 'Test', keyCombo: 'Ctrl+B', script: 'CXL' });
    const exported = exportHotkeys(db);
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].name, 'Test');
    assert.strictEqual(exported[0].keyCombo, 'Ctrl+B');
    assert.strictEqual(exported[0].script, 'CXL');
    assert.strictEqual(exported[0].enabled, true);
  });
});
