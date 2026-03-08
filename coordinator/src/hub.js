#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./db');
const webServer = require('./web-server');
const instanceRegistry = require('./instance-registry');

const HUB_DIR = path.join(os.homedir(), '.mac10');
const PORT = parseInt(process.env.MAC10_HUB_PORT, 10) || 3100;
const scriptDir = process.env.MAC10_SCRIPT_DIR || path.resolve(__dirname, '..', '..');

// Ensure hub data directory exists
fs.mkdirSync(path.join(HUB_DIR, '.claude', 'state'), { recursive: true });

// Initialize DB (stores presets & config only — requests/workers/tasks stay empty)
db.init(HUB_DIR);
console.log(`Hub DB initialized at ${HUB_DIR}`);

// Start web server
webServer.start(HUB_DIR, PORT, scriptDir);
console.log(`Hub dashboard: http://localhost:${PORT}`);

// Register in instance registry
instanceRegistry.register({
  projectDir: HUB_DIR,
  port: PORT,
  pid: process.pid,
  name: '__hub__',
});

// Clean shutdown
function shutdown() {
  console.log('Hub shutting down...');
  instanceRegistry.deregister(PORT);
  webServer.stop();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
