'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const db = require('../src/db');
const { matchTasksToWorkers } = require('../src/allocator');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac10-alloc-'));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  db.init(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Allocator matching', () => {
  it('should match tasks to idle workers', () => {
    const tasks = [
      { id: 1, domain: 'backend', priority: 'normal' },
      { id: 2, domain: 'frontend', priority: 'normal' },
    ];
    const workers = [
      { id: 1, status: 'idle', domain: null },
      { id: 2, status: 'idle', domain: null },
    ];

    const assignments = matchTasksToWorkers(tasks, workers);
    assert.strictEqual(assignments.length, 2);
  });

  it('should prefer domain-matched workers', () => {
    const tasks = [
      { id: 1, domain: 'backend', priority: 'normal' },
    ];
    const workers = [
      { id: 1, status: 'idle', domain: 'frontend' },
      { id: 2, status: 'idle', domain: 'backend' },
    ];

    const assignments = matchTasksToWorkers(tasks, workers);
    assert.strictEqual(assignments.length, 1);
    assert.strictEqual(assignments[0].worker.id, 2);
  });

  it('should fall back to any idle worker when no domain match', () => {
    const tasks = [
      { id: 1, domain: 'database', priority: 'normal' },
    ];
    const workers = [
      { id: 1, status: 'idle', domain: 'frontend' },
    ];

    const assignments = matchTasksToWorkers(tasks, workers);
    assert.strictEqual(assignments.length, 1);
    assert.strictEqual(assignments[0].worker.id, 1);
  });

  it('should not assign more tasks than workers', () => {
    const tasks = [
      { id: 1, domain: null, priority: 'normal' },
      { id: 2, domain: null, priority: 'normal' },
      { id: 3, domain: null, priority: 'normal' },
    ];
    const workers = [
      { id: 1, status: 'idle', domain: null },
    ];

    const assignments = matchTasksToWorkers(tasks, workers);
    assert.strictEqual(assignments.length, 1);
  });

  it('should not double-assign a worker', () => {
    const tasks = [
      { id: 1, domain: 'backend', priority: 'normal' },
      { id: 2, domain: 'backend', priority: 'normal' },
    ];
    const workers = [
      { id: 1, status: 'idle', domain: 'backend' },
    ];

    const assignments = matchTasksToWorkers(tasks, workers);
    assert.strictEqual(assignments.length, 1);
  });
});

describe('Allocator tick (integration)', () => {
  it('should promote and assign tasks in one tick', () => {
    db.registerWorker(1, '/wt-1', 'agent-1');
    const reqId = db.createRequest('Test feature');
    db.createTask({
      request_id: reqId,
      subject: 'Do work',
      description: 'Implement the thing',
      domain: 'backend',
    });

    // Simulate tick
    db.checkAndPromoteTasks();
    const ready = db.getReadyTasks();
    assert.strictEqual(ready.length, 1);

    const idle = db.getIdleWorkers();
    assert.strictEqual(idle.length, 1);

    const assignments = matchTasksToWorkers(ready, idle);
    assert.strictEqual(assignments.length, 1);
  });

  it('should not assign when no idle workers', () => {
    db.registerWorker(1, '/wt-1', 'agent-1');
    db.updateWorker(1, { status: 'busy' });

    const reqId = db.createRequest('Test');
    db.createTask({ request_id: reqId, subject: 'Task', description: 'Desc' });

    db.checkAndPromoteTasks();
    const ready = db.getReadyTasks();
    const idle = db.getIdleWorkers();
    const assignments = matchTasksToWorkers(ready, idle);
    assert.strictEqual(assignments.length, 0);
  });
});
