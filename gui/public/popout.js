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

  function renderWorkers(data) {
    var el = document.getElementById('popout-panel');
    var workers = data.workers || [];
    if (workers.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No workers registered</div>';
      return;
    }
    el.innerHTML = workers.map(function(w) {
      return '<div class="worker-card">' +
        '<div class="worker-name">Worker ' + w.id + '</div>' +
        '<span class="worker-status badge-' + w.status + '">' + w.status + '</span>' +
        (w.domain ? '<div style="font-size:11px;color:#8b949e;margin-top:4px">' + escapeHtml(w.domain) + '</div>' : '') +
        (w.current_task_id ? '<div style="font-size:11px;color:#58a6ff;margin-top:2px">Task #' + w.current_task_id + '</div>' : '') +
        '</div>';
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
      return '<div class="request-item">' +
        '<span class="req-id">' + r.id + '</span>' +
        '<span class="worker-status badge-' + r.status + '">' + r.status + '</span>' +
        (r.tier ? '<span style="font-size:11px;color:#d29922"> T' + r.tier + '</span>' : '') +
        '<div class="req-desc">' + escapeHtml(r.description).slice(0, 200) + '</div>' +
        '</div>';
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
      return '<div class="task-item">' +
        '<span style="color:#58a6ff">#' + t.id + '</span>' +
        '<span class="worker-status badge-' + t.status + '">' + t.status + '</span>' +
        '<div class="task-subject">' + escapeHtml(t.subject) + '</div>' +
        '<div class="task-meta">' +
          (t.domain ? '[' + escapeHtml(t.domain) + ']' : '') + ' T' + t.tier +
          (t.assigned_to ? ' &rarr; worker-' + escapeHtml(String(t.assigned_to)) : '') +
          (t.pr_url ? ' ' + renderPrLink(t.pr_url) : '') +
        '</div>' +
        '</div>';
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
      return '<div class="log-entry">' +
        '<span class="log-time">' + escapeHtml(l.created_at) + '</span> ' +
        '<span class="log-actor">' + escapeHtml(l.actor) + '</span> ' +
        '<span class="log-action">' + escapeHtml(l.action) + '</span>' +
        (l.details ? ' <span style="color:#484f58">' + escapeHtml(l.details.substring(0, 120)) + '</span>' : '') +
        '</div>';
    }).join('');
  }
})();
