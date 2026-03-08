'use strict';

const path = require('path');
const db = require('./db');
const cliServer = require('./cli-server');
const allocator = require('./allocator');
const watchdog = require('./watchdog');
const merger = require('./merger');
const webServer = require('./web-server');
const tmux = require('./tmux');
const overlay = require('./overlay');
const instanceRegistry = require('./instance-registry');

const projectDir = process.argv[2] || process.cwd();
const scriptDir = process.env.MAC10_SCRIPT_DIR || path.resolve(__dirname, '..', '..');

console.log(`mac10 coordinator starting for: ${projectDir}`);

// Initialize database
db.init(projectDir);
console.log('Database initialized.');

// Namespace tmux session per project (optional — not available on native Windows)
tmux.setSession(projectDir);
if (tmux.isAvailable()) {
  tmux.ensureSession();
  console.log(`tmux session "${tmux.SESSION}" ready.`);
} else {
  console.log('tmux not available — workers will be spawned via Windows Terminal tabs.');
}

// Start CLI server (Unix socket for mac10 commands)
const handlers = {
  onTaskCompleted: (taskId) => merger.onTaskCompleted(taskId),
  onShutdown: () => {
    // Forward-reference: shutdown() is defined inside the async IIFE below.
    // Before it's available, fall back to a hard exit.
    if (typeof handlers._shutdown === 'function') handlers._shutdown();
    else process.exit(0);
  },
  onLoopCreated: (loop) => {
    const sentinelPath = path.join(scriptDir, 'scripts', 'loop-sentinel.sh');
    const windowName = `loop-${loop.id}`;
    if (tmux.isAvailable()) {
      tmux.createWindow(windowName, `bash "${sentinelPath}" "${loop.id}" "${projectDir}"`, projectDir);
      db.log('coordinator', 'loop_sentinel_spawned', { loop_id: loop.id, window: windowName });
    }
  },
  onAssignTask: (task, worker) => {
    const worktreePath = worker.worktree_path || path.join(projectDir, '.worktrees', `wt-${worker.id}`);

    // Sync knowledge files from main project to worktree before spawning
    try {
      const srcKnowledge = path.join(projectDir, '.claude', 'knowledge');
      const dstKnowledge = path.join(worktreePath, '.claude', 'knowledge');
      const fs = require('fs');
      fs.mkdirSync(path.join(dstKnowledge, 'domain'), { recursive: true });
      for (const f of fs.readdirSync(srcKnowledge)) {
        const srcFile = path.join(srcKnowledge, f);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, path.join(dstKnowledge, f));
        }
      }
      // Sync domain subdirectory
      const domainDir = path.join(srcKnowledge, 'domain');
      if (fs.existsSync(domainDir)) {
        for (const f of fs.readdirSync(domainDir)) {
          fs.copyFileSync(path.join(domainDir, f), path.join(dstKnowledge, 'domain', f));
        }
      }
    } catch (e) {
      db.log('coordinator', 'knowledge_sync_error', { worker_id: worker.id, error: e.message });
    }

    // Write task overlay to worker's CLAUDE.md
    try {
      overlay.writeOverlay(task, worker, projectDir);
    } catch (e) {
      db.log('coordinator', 'overlay_error', { worker_id: worker.id, error: e.message });
    }

    const windowName = `worker-${worker.id}`;

    if (tmux.isAvailable()) {
      // WSL/Linux/macOS: spawn via tmux
      if (tmux.hasWindow(windowName)) {
        tmux.killWindow(windowName);
      }
      const sentinelPath = path.join(projectDir, '.claude', 'scripts', 'worker-sentinel.sh');
      tmux.createWindow(windowName, `bash "${sentinelPath}" ${worker.id} "${projectDir}"`, worktreePath);
      db.updateWorker(worker.id, {
        tmux_session: tmux.SESSION,
        tmux_window: windowName,
      });
    } else {
      // Native Windows: spawn via launch-worker.sh (opens Windows Terminal tab)
      const launchScript = path.join(projectDir, '.claude', 'scripts', 'launch-worker.sh');
      const { execFile } = require('child_process');
      execFile('bash', [launchScript, String(worker.id)], { cwd: projectDir }, (err) => {
        if (err) db.log('coordinator', 'launch_worker_error', { worker_id: worker.id, error: err.message });
      });
    }
    db.log('coordinator', 'worker_spawned', { worker_id: worker.id, window: windowName });
  },
};
cliServer.start(projectDir, handlers);
console.log('CLI server listening.');

// Start allocator loop (every 2s)
allocator.start(projectDir);
console.log('Allocator running.');

// Start watchdog loop (every 10s)
watchdog.start(projectDir);
console.log('Watchdog running.');

// Start merger (triggered + periodic)
merger.start(projectDir);
console.log('Merger running.');

// Start web dashboard — single dashboard at port 3100 (or next free port)
// All project coordinators register in the shared instance registry so the
// dashboard at /api/instances can manage them all from one place.
(async () => {
  const port = parseInt(process.env.MAC10_PORT) || await instanceRegistry.acquirePort(3100);
  // shutdown is defined below — forward-referenced via closure
  webServer.start(projectDir, port, scriptDir, {
    onShutdown: () => shutdown(),
  });
  console.log(`Web dashboard: http://localhost:${port}`);

  instanceRegistry.register({
    projectDir,
    port,
    pid: process.pid,
    name: path.basename(projectDir),
    tmuxSession: tmux.SESSION,
    startedAt: new Date().toISOString(),
  });
  console.log('Instance registered in shared registry.');

  // Re-wire shutdown to know the port — also expose via handlers for CLI server
  function shutdown() {
    console.log('Shutting down...');
    instanceRegistry.deregister(port);
    allocator.stop();
    watchdog.stop();
    merger.stop();
    cliServer.stop();
    webServer.stop();
    db.log('coordinator', 'stopped');
    db.close();
    process.exit(0);
  }
  handlers._shutdown = shutdown;
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  db.log('coordinator', 'started', { project_dir: projectDir, port });
  console.log('mac10 coordinator ready.');

  // Auto-launch Master-1 (Interface) so the user always has an interactive agent
  if (tmux.isAvailable()) {
    const masterWindowName = 'master-1';
    if (!tmux.hasWindow(masterWindowName)) {
      const launchAgentPath = path.join(scriptDir, 'scripts', 'launch-agent.sh');
      const fs = require('fs');
      if (fs.existsSync(launchAgentPath)) {
        tmux.createWindow(masterWindowName, `bash "${launchAgentPath}" "${projectDir}" sonnet /master-loop`, projectDir);
        db.log('coordinator', 'master1_launched', { window: masterWindowName });
        console.log('Master-1 (Interface) launched.');
      }
    }
  }
})();

// Crash handlers — log and exit cleanly instead of dying silently
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  try { db.log('coordinator', 'uncaught_exception', { error: err.message, stack: err.stack }); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled rejection:', msg);
  try { db.log('coordinator', 'unhandled_rejection', { error: msg }); } catch {}
});
