'use strict';

const { execSync, execFileSync } = require('child_process');
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

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts }).trim();
  } catch (e) {
    if (opts.ignoreError) return '';
    throw e;
  }
}

let available = null;

function isAvailable() {
  if (available === null) {
    try {
      execSync('tmux -V', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
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
    exec(`tmux has-session -t ${SESSION} 2>/dev/null`);
  } catch {
    exec(`tmux new-session -d -s ${SESSION} -n coordinator`);
  }
}

function createWindow(name, cmd, cwd, envVars) {
  if (!isAvailable()) throw new Error('tmux not available — use Windows Terminal tab spawning');
  ensureSession();
  const cwdFlag = cwd ? `-c "${cwd}"` : '';
  exec(`tmux new-window -t ${SESSION} -n "${name}" ${cwdFlag}`);
  if (cmd) {
    // Set environment variables in the pane before running the command
    // Uses execFileSync (array args) to avoid shell interpolation of values
    if (envVars && typeof envVars === 'object') {
      for (const [k, v] of Object.entries(envVars)) {
        execFileSync('tmux', ['set-environment', '-t', SESSION, k, v], { encoding: 'utf8', timeout: 10000 });
        execFileSync('tmux', ['send-keys', '-t', `${SESSION}:${name}`, `export ${k}=${JSON.stringify(v)}`, 'Enter'], { encoding: 'utf8', timeout: 10000 });
      }
    }
    exec(`tmux send-keys -t ${SESSION}:${name} "${cmd}" Enter`);
  }
}

function sendKeys(window, keys) {
  exec(`tmux send-keys -t ${SESSION}:${window} "${keys}" Enter`);
}

function isPaneAlive(window) {
  if (!isAvailable()) return false;
  try {
    const result = exec(`tmux list-panes -t ${SESSION}:${window} -F "#{pane_pid}" 2>/dev/null`, { ignoreError: true });
    return result.length > 0;
  } catch {
    return false;
  }
}

function getPanePid(window) {
  try {
    const pid = exec(`tmux list-panes -t ${SESSION}:${window} -F "#{pane_pid}" 2>/dev/null`, { ignoreError: true });
    return pid ? parseInt(pid, 10) : null;
  } catch {
    return null;
  }
}

function killWindow(window) {
  exec(`tmux kill-window -t ${SESSION}:${window} 2>/dev/null`, { ignoreError: true });
}

function listWindows() {
  try {
    const out = exec(`tmux list-windows -t ${SESSION} -F "#{window_name}" 2>/dev/null`, { ignoreError: true });
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hasWindow(name) {
  return listWindows().includes(name);
}

function killSession() {
  exec(`tmux kill-session -t ${SESSION} 2>/dev/null`, { ignoreError: true });
}

function capturePane(window, lines = 50) {
  try {
    return exec(`tmux capture-pane -t ${SESSION}:${window} -p -S -${lines} 2>/dev/null`, { ignoreError: true });
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
