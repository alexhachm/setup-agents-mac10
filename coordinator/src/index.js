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

const projectDir = process.argv[2] || process.cwd();
const scriptDir = process.env.MAC10_SCRIPT_DIR || path.resolve(__dirname, '..', '..');

console.log(`mac10 coordinator starting for: ${projectDir}`);

// Initialize database
db.init(projectDir);
console.log('Database initialized.');

// Ensure tmux session
tmux.ensureSession();
console.log(`tmux session "${tmux.SESSION}" ready.`);

// Start CLI server (Unix socket for mac10 commands)
const handlers = {
  onTaskCompleted: (taskId) => merger.onTaskCompleted(taskId),
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
    if (tmux.hasWindow(windowName)) return;
    const sentinelPath = path.join(projectDir, '.claude', 'scripts', 'worker-sentinel.sh');
    tmux.createWindow(windowName, `bash "${sentinelPath}" ${worker.id} "${projectDir}"`, worktreePath);
    db.updateWorker(worker.id, {
      tmux_session: tmux.SESSION,
      tmux_window: windowName,
    });
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

// Start web dashboard
const port = parseInt(process.env.MAC10_PORT) || 3100;
webServer.start(projectDir, port, scriptDir);
console.log(`Web dashboard: http://localhost:${port}`);

db.log('coordinator', 'started', { project_dir: projectDir, port });
console.log('mac10 coordinator ready.');

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  allocator.stop();
  watchdog.stop();
  cliServer.stop();
  webServer.stop();
  db.log('coordinator', 'stopped');
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep alive
setInterval(() => {}, 60000);
