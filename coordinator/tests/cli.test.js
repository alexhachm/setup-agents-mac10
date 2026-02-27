'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const db = require('../src/db');
const cliServer = require('../src/cli-server');

let tmpDir;
let server;
let socketPath;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac10-cli-'));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  db.init(tmpDir);
  socketPath = cliServer.getSocketPath(tmpDir);
  server = cliServer.start(tmpDir, { onTaskCompleted: () => {} });
  // Wait for server to be listening
  await new Promise((resolve) => {
    const check = () => {
      const conn = net.createConnection(socketPath, () => {
        conn.end();
        resolve();
      });
      conn.on('error', () => setTimeout(check, 50));
    };
    // Give server a moment to bind
    setTimeout(check, 50);
  });
});

afterEach(() => {
  cliServer.stop();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sendCommand(command, args) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => {
      conn.write(JSON.stringify({ command, args }) + '\n');
    });
    let data = '';
    conn.on('data', (chunk) => {
      data += chunk.toString();
      const idx = data.indexOf('\n');
      if (idx >= 0) {
        resolve(JSON.parse(data.slice(0, idx)));
        conn.end();
      }
    });
    conn.on('error', reject);
    conn.setTimeout(5000, () => { conn.end(); reject(new Error('Timeout')); });
  });
}

describe('CLI Server', () => {
  it('should respond to ping', async () => {
    const result = await sendCommand('ping', {});
    assert.strictEqual(result.ok, true);
    assert.ok(result.ts);
  });

  it('should create a request', async () => {
    const result = await sendCommand('request', { description: 'Add login page' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.request_id.startsWith('req-'));

    const req = db.getRequest(result.request_id);
    assert.strictEqual(req.description, 'Add login page');
    assert.strictEqual(req.status, 'pending');
  });

  it('should create an urgent fix', async () => {
    const result = await sendCommand('fix', { description: 'Login broken' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.request_id);
    assert.ok(result.task_id);

    const task = db.getTask(result.task_id);
    assert.strictEqual(task.priority, 'urgent');
    assert.strictEqual(task.status, 'ready');
  });

  it('should return status', async () => {
    db.createRequest('Req 1');
    db.registerWorker(1, '/wt-1', 'agent-1');

    const result = await sendCommand('status', {});
    assert.strictEqual(result.ok, true);
    assert.ok(result.requests.length >= 1);
    assert.strictEqual(result.workers.length, 1);
  });

  it('should handle triage', async () => {
    const reqResult = await sendCommand('request', { description: 'Fix typo' });
    const result = await sendCommand('triage', {
      request_id: reqResult.request_id,
      tier: 1,
      reasoning: 'Simple fix',
    });
    assert.strictEqual(result.ok, true);

    const req = db.getRequest(reqResult.request_id);
    assert.strictEqual(req.tier, 1);
    assert.strictEqual(req.status, 'executing_tier1');
  });

  it('should create tasks', async () => {
    const reqResult = await sendCommand('request', { description: 'Feature' });
    const result = await sendCommand('create-task', {
      request_id: reqResult.request_id,
      subject: 'Add endpoint',
      description: 'Create POST /api/items',
      domain: 'backend',
      tier: 2,
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.task_id);

    const task = db.getTask(result.task_id);
    assert.strictEqual(task.status, 'ready'); // no deps → auto-ready
  });

  it('should handle worker task lifecycle', async () => {
    db.registerWorker(1, '/wt-1', 'agent-1');
    const reqId = db.createRequest('Feature');
    const taskId = db.createTask({ request_id: reqId, subject: 'Work', description: 'Do it' });
    db.updateTask(taskId, { status: 'assigned', assigned_to: 1 });
    db.updateWorker(1, { status: 'assigned', current_task_id: taskId });

    // Get task
    let result = await sendCommand('my-task', { worker_id: '1' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.task.id, taskId);

    // Start task
    result = await sendCommand('start-task', { worker_id: '1', task_id: String(taskId) });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(db.getTask(taskId).status, 'in_progress');

    // Heartbeat
    result = await sendCommand('heartbeat', { worker_id: '1' });
    assert.strictEqual(result.ok, true);

    // Complete task
    result = await sendCommand('complete-task', {
      worker_id: '1',
      task_id: String(taskId),
      pr_url: 'https://github.com/org/repo/pull/42',
      branch: 'agent-1',
      result: 'Added the endpoint',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(db.getTask(taskId).status, 'completed');
    assert.strictEqual(db.getWorker(1).status, 'completed_task');
  });

  it('should handle inbox', async () => {
    db.sendMail('architect', 'test_msg', { data: 'hello' });

    const result = await sendCommand('inbox', { recipient: 'architect' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.messages.length, 1);
    assert.strictEqual(result.messages[0].type, 'test_msg');
  });

  it('should repair stuck state', async () => {
    db.registerWorker(1, '/wt-1', 'agent-1');

    // Simulate stuck worker (stale heartbeat)
    db.updateWorker(1, {
      status: 'busy',
      last_heartbeat: new Date(Date.now() - 300000).toISOString(), // 5 min ago
    });

    const result = await sendCommand('repair', {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reset_workers, 1);
    assert.strictEqual(db.getWorker(1).status, 'idle');
  });

  it('should return error for unknown commands', async () => {
    const result = await sendCommand('nonexistent', {});
    assert.ok(result.error);
  });
});
