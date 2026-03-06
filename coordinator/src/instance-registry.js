'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const REGISTRY_PATH = path.join(os.tmpdir(), 'mac10-instances.json');
const LOCK_PATH = REGISTRY_PATH + '.lock';
const LOCK_STALE_MS = 10000;

function acquireLock() {
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      // Check if lock is stale
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch { continue; }
      // Brief spin wait
      const start = Date.now();
      while (Date.now() - start < 50) { /* spin */ }
    }
  }
  // Force remove stale lock as last resort
  try { fs.unlinkSync(LOCK_PATH); } catch {}
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

function readRegistry() {
  try {
    const data = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function register({ projectDir, port, pid, name, tmuxSession, startedAt }) {
  acquireLock();
  try {
    const entries = readRegistry().filter(e => e.port !== port);
    entries.push({ projectDir, port, pid, name, tmuxSession, startedAt: startedAt || new Date().toISOString() });
    writeRegistry(entries);
  } finally {
    releaseLock();
  }
}

function deregister(port) {
  acquireLock();
  try {
    const entries = readRegistry().filter(e => e.port !== port);
    writeRegistry(entries);
  } finally {
    releaseLock();
  }
}

function list() {
  acquireLock();
  try {
    const entries = readRegistry();
    const alive = entries.filter(e => isPidAlive(e.pid));
    if (alive.length !== entries.length) {
      writeRegistry(alive);
    }
    return alive;
  } finally {
    releaseLock();
  }
}

function findByProject(dir) {
  const resolved = path.resolve(dir);
  return list().find(e => path.resolve(e.projectDir) === resolved) || null;
}

function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

async function acquirePort(base = 3100) {
  const entries = list();
  const usedPorts = new Set(entries.map(e => e.port));
  for (let port = base; port < base + 100; port++) {
    if (usedPorts.has(port)) continue;
    if (await probePort(port)) return port;
  }
  throw new Error('No free port found in range ' + base + '-' + (base + 99));
}

module.exports = { register, deregister, list, findByProject, acquirePort, REGISTRY_PATH };
