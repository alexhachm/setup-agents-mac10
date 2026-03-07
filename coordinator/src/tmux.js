'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');

let SESSION = 'mac10';

function setSession(projectDir) {
  const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 6);
  SESSION = `mac10-${hash}`;
  return SESSION;
}

function getSession() {
  return SESSION;
}

// Safe exec using execFileSync with array args — no shell interpolation
function safeExec(args, opts = {}) {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (e) {
    if (opts.ignoreError) return '';
    throw e;
  }
}

let available = null;

function isAvailable() {
  if (available === null) {
    try {
      execFileSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      available = true;
    } catch {
      available = false;
    }
  }
  return available;
}

function ensureSession() {
  if (!isAvailable()) return;
  try {
    safeExec(['has-session', '-t', SESSION]);
  } catch {
    safeExec(['new-session', '-d', '-s', SESSION, '-n', 'coordinator']);
  }
}

function createWindow(name, cmd, cwd, envVars) {
  if (!isAvailable()) throw new Error('tmux not available — use Windows Terminal tab spawning');
  ensureSession();
  const args = ['new-window', '-t', SESSION, '-n', name];
  if (cwd) args.push('-c', cwd);
  safeExec(args);
  if (cmd) {
    // Set environment variables in the pane before running the command
    if (envVars && typeof envVars === 'object') {
      for (const [k, v] of Object.entries(envVars)) {
        safeExec(['set-environment', '-t', SESSION, k, v]);
        safeExec(['send-keys', '-t', `${SESSION}:${name}`, `export ${k}=${JSON.stringify(v)}`, 'Enter']);
      }
    }
    safeExec(['send-keys', '-t', `${SESSION}:${name}`, cmd, 'Enter']);
  }
}

function sendKeys(window, keys) {
  safeExec(['send-keys', '-t', `${SESSION}:${window}`, keys, 'Enter']);
}

function isPaneAlive(window) {
  if (!isAvailable()) return false;
  try {
    const result = safeExec(
      ['list-panes', '-t', `${SESSION}:${window}`, '-F', '#{pane_pid}'],
      { ignoreError: true }
    );
    return result.length > 0;
  } catch {
    return false;
  }
}

function getPanePid(window) {
  try {
    const pid = safeExec(
      ['list-panes', '-t', `${SESSION}:${window}`, '-F', '#{pane_pid}'],
      { ignoreError: true }
    );
    return pid ? parseInt(pid, 10) : null;
  } catch {
    return null;
  }
}

function killWindow(window) {
  safeExec(['kill-window', '-t', `${SESSION}:${window}`], { ignoreError: true });
}

function listWindows() {
  try {
    const out = safeExec(
      ['list-windows', '-t', SESSION, '-F', '#{window_name}'],
      { ignoreError: true }
    );
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hasWindow(name) {
  return listWindows().includes(name);
}

function killSession() {
  safeExec(['kill-session', '-t', SESSION], { ignoreError: true });
}

function capturePane(window, lines = 50) {
  try {
    return safeExec(
      ['capture-pane', '-t', `${SESSION}:${window}`, '-p', '-S', `-${lines}`],
      { ignoreError: true }
    );
  } catch {
    return '';
  }
}

module.exports = {
  get SESSION() { return SESSION; },
  setSession,
  getSession,
  isAvailable,
  ensureSession,
  createWindow,
  sendKeys,
  isPaneAlive,
  getPanePid,
  killWindow,
  listWindows,
  hasWindow,
  killSession,
  capturePane,
};
