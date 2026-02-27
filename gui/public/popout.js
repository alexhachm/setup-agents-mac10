(function() {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const panel = params.get('panel');

  const PANELS = {
    workers: { title: 'Workers', render: renderWorkers },
    requests: { title: 'Requests', render: renderRequests },
    tasks: { title: 'Tasks', render: renderTasks },
    log: { title: 'Activity Log', render: renderLog },
  };

  const config = PANELS[panel];
  if (!config) {
    document.getElementById('panel-content').innerHTML =
      '<div style="color:#f85149;padding:20px">Unknown panel: ' + escapeHtml(panel || '(none)') + '</div>';
    return;
  }

  document.getElementById('panel-title').textContent = config.title;
  document.title = 'mac10 — ' + config.title;

  // Set up panel container
  var contentEl = document.getElementById('panel-content');
  contentEl.innerHTML = '<div id="popout-panel"></div>';

  // --- Column definitions (mirrored from app.js) ---
  var PANEL_COLUMNS = {
    workers: [
      { key: 'id', label: 'Worker' },
      { key: 'status', label: 'Status' },
      { key: 'domain', label: 'Domain' },
      { key: 'current_task_id', label: 'Task' },
    ],
    requests: [
      { key: 'id', label: 'ID' },
      { key: 'status', label: 'Status' },
      { key: 'tier', label: 'Tier' },
      { key: 'description', label: 'Description' },
    ],
    tasks: [
      { key: 'id', label: 'ID' },
      { key: 'status', label: 'Status' },
      { key: 'subject', label: 'Subject' },
      { key: 'domain', label: 'Domain' },
      { key: 'tier', label: 'Tier' },
      { key: 'assigned_to', label: 'Assigned' },
      { key: 'pr_url', label: 'PR' },
    ],
    log: [
      { key: 'created_at', label: 'Time' },
      { key: 'actor', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'details', label: 'Details' },
    ],
  };

  var SETTINGS_KEY = 'mac10_panel_settings';

  function loadColumnOrder(panelName) {
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (saved[panelName] && Array.isArray(saved[panelName])) {
        var defaults = PANEL_COLUMNS[panelName].map(function(c) { return c.key; });
        var order = saved[panelName].filter(function(k) { return defaults.indexOf(k) !== -1; });
        defaults.forEach(function(k) { if (order.indexOf(k) === -1) order.push(k); });
        return order;
      }
    } catch (e) { /* ignore */ }
    return PANEL_COLUMNS[panelName].map(function(c) { return c.key; });
  }

  function getOrderedColumns(panelName) {
    var order = loadColumnOrder(panelName);
    var colMap = {};
    PANEL_COLUMNS[panelName].forEach(function(c) { colMap[c.key] = c; });
    return order.map(function(k) { return colMap[k]; }).filter(Boolean);
  }

  var ws = null;
  var reconnectTimer = null;
  var reconnectDelay = 1000;
  var MAX_RECONNECT_DELAY = 30000;

  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.onopen = function() {
      document.getElementById('status-indicator').className = 'status-dot connected';
      document.getElementById('status-text').textContent = 'Connected';
      reconnectDelay = 1000;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = function() {
      document.getElementById('status-indicator').className = 'status-dot disconnected';
      document.getElementById('status-text').textContent = 'Disconnected';
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    };

    ws.onmessage = function(event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'init' || msg.type === 'state') {
          config.render(msg.data);
        }
      } catch (e) { console.error('WS parse error:', e); }
    };
  }

  // Also fetch initial state via REST
  fetch('/api/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      config.render(data);
    })
    .catch(function(err) { console.error('Status fetch failed:', err); });

  connect();

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function safeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      var parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (e) {}
    return null;
  }

  function renderPrLink(prUrl) {
    var safe = safeUrl(prUrl);
    if (!safe) return '';
    return '<a href="' + safe + '" target="_blank" rel="noopener" style="color:#58a6ff">PR</a>';
  }

  // Column renderers per panel
  var COLUMN_RENDERERS = {
    workers: {
      id: function(w) { return '<div class="worker-name">Worker ' + w.id + '</div>'; },
      status: function(w) { return '<span class="worker-status badge-' + w.status + '">' + w.status + '</span>'; },
      domain: function(w) { return w.domain ? '<div style="font-size:11px;color:#8b949e;margin-top:4px">' + escapeHtml(w.domain) + '</div>' : ''; },
      current_task_id: function(w) { return w.current_task_id ? '<div style="font-size:11px;color:#58a6ff;margin-top:2px">Task #' + w.current_task_id + '</div>' : ''; },
    },
    requests: {
      id: function(r) { return '<span class="req-id">' + r.id + '</span>'; },
      status: function(r) { return '<span class="worker-status badge-' + r.status + '">' + r.status + '</span>'; },
      tier: function(r) { return r.tier ? '<span style="font-size:11px;color:#d29922"> T' + r.tier + '</span>' : ''; },
      description: function(r) { return '<div class="req-desc">' + escapeHtml(r.description).slice(0, 200) + '</div>'; },
    },
    tasks: {
      id: function(t) { return '<span style="color:#58a6ff">#' + t.id + '</span>'; },
      status: function(t) { return '<span class="worker-status badge-' + t.status + '">' + t.status + '</span>'; },
      subject: function(t) { return '<div class="task-subject">' + escapeHtml(t.subject) + '</div>'; },
      domain: function(t) { return t.domain ? '<span class="task-meta-field">[' + escapeHtml(t.domain) + ']</span>' : ''; },
      tier: function(t) { return '<span class="task-meta-field">T' + t.tier + '</span>'; },
      assigned_to: function(t) { return t.assigned_to ? '<span class="task-meta-field">&rarr; worker-' + escapeHtml(String(t.assigned_to)) + '</span>' : ''; },
      pr_url: function(t) { return t.pr_url ? renderPrLink(t.pr_url) : ''; },
    },
    log: {
      created_at: function(l) { return '<span class="log-time">' + escapeHtml(l.created_at) + '</span>'; },
      actor: function(l) { return '<span class="log-actor">' + escapeHtml(l.actor) + '</span>'; },
      action: function(l) { return '<span class="log-action">' + escapeHtml(l.action) + '</span>'; },
      details: function(l) { return l.details ? '<span style="color:#484f58">' + escapeHtml(l.details.substring(0, 120)) + '</span>' : ''; },
    },
  };

  function renderItemColumns(panelName, item) {
    var cols = getOrderedColumns(panelName);
    var renderers = COLUMN_RENDERERS[panelName];
    return cols.map(function(c) { return renderers[c.key] ? renderers[c.key](item) : ''; }).join('\n');
  }

  function renderWorkers(data) {
    var el = document.getElementById('popout-panel');
    var workers = data.workers || [];
    if (workers.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No workers registered</div>';
      return;
    }
    el.innerHTML = workers.map(function(w) {
      return '<div class="worker-card">' + renderItemColumns('workers', w) + '</div>';
    }).join('');
  }

  function renderRequests(data) {
    var el = document.getElementById('popout-panel');
    var requests = data.requests || [];
    if (requests.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No requests</div>';
      return;
    }
    el.innerHTML = requests.slice(0, 50).map(function(r) {
      return '<div class="request-item">' + renderItemColumns('requests', r) + '</div>';
    }).join('');
  }

  function renderTasks(data) {
    var el = document.getElementById('popout-panel');
    var tasks = data.tasks || [];
    if (tasks.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No tasks</div>';
      return;
    }
    el.innerHTML = tasks.slice(0, 50).map(function(t) {
      return '<div class="task-item">' + renderItemColumns('tasks', t) + '</div>';
    }).join('');
  }

  function renderLog(data) {
    var el = document.getElementById('popout-panel');
    var logs = data.logs || [];
    if (logs.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No log entries</div>';
      return;
    }
    el.innerHTML = logs.reverse().slice(0, 100).map(function(l) {
      return '<div class="log-entry">' + renderItemColumns('log', l) + '</div>';
    }).join('');
  }
})();
