'use strict';

const { execSync, execFileSync } = require('child_process');

const SESSION = 'mac10';

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts }).trim();
  } catch (e) {
    if (opts.ignoreError) return '';
    throw e;
  }
}

function ensureSession() {
  try {
    exec(`tmux has-session -t ${SESSION} 2>/dev/null`);
  } catch {
    exec(`tmux new-session -d -s ${SESSION} -n coordinator`);
  }
}

function createWindow(name, cmd, cwd) {
  ensureSession();
  const cwdFlag = cwd ? `-c "${cwd}"` : '';
  exec(`tmux new-window -t ${SESSION} -n "${name}" ${cwdFlag}`);
  if (cmd) {
    exec(`tmux send-keys -t ${SESSION}:${name} "${cmd}" Enter`);
  }
}

function sendKeys(window, keys) {
  exec(`tmux send-keys -t ${SESSION}:${window} "${keys}" Enter`);
}

function isPaneAlive(window) {
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
  SESSION,
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
