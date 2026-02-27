-- mac10 coordinator schema
-- SQLite WAL mode for concurrent reads, serialized writes

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- User requests (replaces handoff.json)
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  tier INTEGER,  -- 1, 2, or 3 (set after triage)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','triaging','executing_tier1','decomposed','in_progress','integrating','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  result TEXT  -- summary of outcome
);

-- Tasks decomposed from requests (replaces task-queue.json + worker-N.json)
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  domain TEXT,
  files TEXT,  -- JSON array of file paths
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  tier INTEGER NOT NULL DEFAULT 3,
  depends_on TEXT,  -- JSON array of task IDs
  assigned_to INTEGER REFERENCES workers(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','assigned','in_progress','completed','failed','blocked')),
  pr_url TEXT,
  branch TEXT,
  validation TEXT,  -- JSON: what checks to run
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  result TEXT  -- outcome summary
);

-- Workers (replaces worker-status.json)
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY,  -- worker number (1-8)
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','assigned','running','busy','completed_task','resetting')),
  domain TEXT,
  worktree_path TEXT,
  branch TEXT,
  tmux_session TEXT,
  tmux_window TEXT,
  pid INTEGER,
  current_task_id INTEGER REFERENCES tasks(id),
  last_heartbeat TEXT,
  launched_at TEXT,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mail (replaces ALL signal files + IPC)
CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,  -- 'architect', 'worker-N', 'coordinator', 'all'
  type TEXT NOT NULL,  -- 'new_request','triage_result','task_assigned','task_completed','heartbeat','clarification_ask','clarification_reply','nudge','terminate'
  payload TEXT NOT NULL DEFAULT '{}',  -- JSON
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Merge queue (new in mac10)
CREATE TABLE IF NOT EXISTS merge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  pr_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','merging','merged','conflict','failed')),
  priority INTEGER NOT NULL DEFAULT 0,  -- higher = merge first
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT,
  error TEXT
);

-- Activity log (replaces activity.log)
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,  -- 'coordinator','architect','worker-N','user'
  action TEXT NOT NULL,
  details TEXT,  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Config (coordinator settings)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_request ON tasks(request_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_mail_recipient ON mail(recipient, consumed);
CREATE INDEX IF NOT EXISTS idx_mail_type ON mail(type);
CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log(actor);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);

-- Default config
INSERT OR IGNORE INTO config (key, value) VALUES
  ('max_workers', '8'),
  ('heartbeat_timeout_s', '60'),
  ('watchdog_interval_ms', '10000'),
  ('allocator_interval_ms', '2000'),
  ('merge_validation', 'true'),
  ('project_dir', ''),
  ('coordinator_version', '1.0.0');
