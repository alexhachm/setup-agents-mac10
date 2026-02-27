(function() {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  let setupRunning = false;
  let gitPushing = false;

  // --- Color-link system for panels ---
  const LINK_COLORS = [null, '#f85149', '#58a6ff', '#3fb950', '#d29922', '#bc8cff'];
  const LINK_COLOR_NAMES = ['none', 'red', 'blue', 'green', 'orange', 'purple'];
  const LINK_SETTINGS_KEY = 'mac10_panel_links';
  const PANEL_ORDER_KEY = 'mac10_panel_order';
  const GRID_PANELS = ['workers', 'requests', 'tasks', 'log'];

  function loadPanelLinks() {
    try {
      return JSON.parse(localStorage.getItem(LINK_SETTINGS_KEY) || '{}');
    } catch (e) { return {}; }
  }

  function savePanelLinks(links) {
    try { localStorage.setItem(LINK_SETTINGS_KEY, JSON.stringify(links)); } catch (e) { /* ignore */ }
  }

  function getPanelLinkColor(panelName) {
    const links = loadPanelLinks();
    return links[panelName] || null;
  }

  function cyclePanelLink(panelName) {
    const links = loadPanelLinks();
    const currentIdx = LINK_COLORS.indexOf(links[panelName] || null);
    const nextIdx = (currentIdx + 1) % LINK_COLORS.length;
    links[panelName] = LINK_COLORS[nextIdx];
    if (!links[panelName]) delete links[panelName];
    savePanelLinks(links);
    updateAllLinkIndicators();
  }

  function updateAllLinkIndicators() {
    document.querySelectorAll('.panel-header[data-panel]').forEach(function(header) {
      const panel = header.getAttribute('data-panel');
      const color = getPanelLinkColor(panel);
      let dot = header.querySelector('.link-color-dot');
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'link-color-dot';
        dot.title = 'Click to cycle link color';
        dot.addEventListener('click', function(e) {
          e.stopPropagation();
          cyclePanelLink(panel);
        });
        header.appendChild(dot);
      }
      if (color) {
        dot.style.background = color;
        dot.style.borderColor = color;
        dot.classList.add('active');
      } else {
        dot.style.background = '';
        dot.style.borderColor = '';
        dot.classList.remove('active');
      }
    });
  }

  // --- Panel order persistence ---
  function loadPanelOrder() {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_ORDER_KEY) || '[]');
      if (saved.length === GRID_PANELS.length && GRID_PANELS.every(p => saved.includes(p))) {
        return saved;
      }
    } catch (e) { /* ignore */ }
    return GRID_PANELS.slice();
  }

  function savePanelOrder(order) {
    try { localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(order)); } catch (e) { /* ignore */ }
  }

  function applyPanelOrder() {
    const order = loadPanelOrder();
    const grid = document.querySelector('.grid');
    if (!grid) return;
    order.forEach(function(panelName) {
      var section = document.getElementById(panelName + '-panel');
      if (section && section.parentNode === grid) {
        grid.appendChild(section);
      }
    });
  }

  // --- Panel drag-and-drop ---
  let draggedPanel = null;

  function initPanelDrag() {
    var grid = document.querySelector('.grid');
    if (!grid) return;

    grid.querySelectorAll('section').forEach(function(section) {
      section.setAttribute('draggable', 'true');

      section.addEventListener('dragstart', function(e) {
        draggedPanel = section;
        section.classList.add('panel-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', section.id);
      });

      section.addEventListener('dragend', function() {
        section.classList.remove('panel-dragging');
        grid.querySelectorAll('.panel-drag-over').forEach(function(el) {
          el.classList.remove('panel-drag-over');
        });
        draggedPanel = null;
      });

      section.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (draggedPanel && draggedPanel !== section) {
          section.classList.add('panel-drag-over');
        }
      });

      section.addEventListener('dragleave', function() {
        section.classList.remove('panel-drag-over');
      });

      section.addEventListener('drop', function(e) {
        e.preventDefault();
        section.classList.remove('panel-drag-over');
        if (!draggedPanel || draggedPanel === section) return;

        var draggedName = draggedPanel.id.replace('-panel', '');
        var targetName = section.id.replace('-panel', '');
        var order = loadPanelOrder();
        var dragIdx = order.indexOf(draggedName);
        var targetIdx = order.indexOf(targetName);
        if (dragIdx === -1 || targetIdx === -1) return;

        var dragColor = getPanelLinkColor(draggedName);
        if (dragColor) {
          var linkedPanels = order.filter(function(p) { return getPanelLinkColor(p) === dragColor; });
          if (linkedPanels.indexOf(targetName) !== -1) return;
          var remaining = order.filter(function(p) { return getPanelLinkColor(p) !== dragColor; });
          var insertIdx = remaining.indexOf(targetName);
          if (insertIdx === -1) return;
          var insertAt = (dragIdx < targetIdx) ? insertIdx + 1 : insertIdx;
          for (var i = 0; i < linkedPanels.length; i++) {
            remaining.splice(insertAt + i, 0, linkedPanels[i]);
          }
          order = remaining;
        } else {
          order.splice(dragIdx, 1);
          var newIdx = order.indexOf(targetName);
          if (dragIdx < targetIdx) {
            order.splice(newIdx + 1, 0, draggedName);
          } else {
            order.splice(newIdx, 0, draggedName);
          }
        }

        savePanelOrder(order);
        applyPanelOrder();
      });
    });
  }

  // --- Column definitions per panel ---
  const PANEL_COLUMNS = {
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

  // --- Column order persistence ---
  const SETTINGS_KEY = 'mac10_panel_settings';

  function loadColumnOrder(panelName) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (saved[panelName] && Array.isArray(saved[panelName])) {
        const defaults = PANEL_COLUMNS[panelName].map(c => c.key);
        const order = saved[panelName].filter(k => defaults.includes(k));
        defaults.forEach(k => { if (!order.includes(k)) order.push(k); });
        return order;
      }
    } catch (e) { /* ignore */ }
    return PANEL_COLUMNS[panelName].map(c => c.key);
  }

  function saveColumnOrder(panelName, order) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      saved[panelName] = order;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
    } catch (e) { /* ignore */ }
  }

  function getOrderedColumns(panelName) {
    const order = loadColumnOrder(panelName);
    const colMap = {};
    PANEL_COLUMNS[panelName].forEach(c => { colMap[c.key] = c; });
    return order.map(k => colMap[k]).filter(Boolean);
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      document.getElementById('status-indicator').className = 'status-dot connected';
      document.getElementById('status-text').textContent = 'Connected';
      reconnectDelay = 1000;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = () => {
      document.getElementById('status-indicator').className = 'status-dot disconnected';
      document.getElementById('status-text').textContent = 'Disconnected';
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init' || msg.type === 'state') {
          renderState(msg.data);
        } else if (msg.type === 'request_created') {
          fetchStatus();
        } else if (msg.type === 'setup_log') {
          appendSetupLog(msg.line);
        } else if (msg.type === 'setup_complete') {
          onSetupComplete(msg.code);
        } else if (msg.type === 'git_push_log') {
          appendGitLog(msg.line);
        } else if (msg.type === 'git_push_complete') {
          onGitPushComplete(msg.code);
        }
      } catch (e) { console.error('WS parse error:', e); }
    };
  }

  function renderState(data) {
    renderWorkers(data.workers || []);
    renderRequests(data.requests || []);
    renderTasks(data.tasks || []);
  }

  // --- Column renderers per panel ---
  const COLUMN_RENDERERS = {
    workers: {
      id: (w) => `<div class="worker-name">Worker ${w.id}</div>`,
      status: (w) => `<span class="worker-status badge-${w.status}">${w.status}</span>`,
      domain: (w) => w.domain ? `<div style="font-size:11px;color:#8b949e;margin-top:4px">${escapeHtml(w.domain)}</div>` : '',
      current_task_id: (w) => w.current_task_id ? `<div style="font-size:11px;color:#58a6ff;margin-top:2px">Task #${w.current_task_id}</div>` : '',
    },
    requests: {
      id: (r) => `<span class="req-id">${r.id}</span>`,
      status: (r) => `<span class="worker-status badge-${r.status}">${r.status}</span>`,
      tier: (r) => r.tier ? `<span style="font-size:11px;color:#d29922"> T${r.tier}</span>` : '',
      description: (r) => `<div class="req-desc">${escapeHtml(r.description).slice(0, 100)}</div>`,
    },
    tasks: {
      id: (t) => `<span style="color:#58a6ff">#${t.id}</span>`,
      status: (t) => `<span class="worker-status badge-${t.status}">${t.status}</span>`,
      subject: (t) => `<div class="task-subject">${escapeHtml(t.subject)}</div>`,
      domain: (t) => t.domain ? `<span class="task-meta-field">[${escapeHtml(t.domain)}]</span>` : '',
      tier: (t) => `<span class="task-meta-field">T${t.tier}</span>`,
      assigned_to: (t) => t.assigned_to ? `<span class="task-meta-field">\u2192 worker-${escapeHtml(String(t.assigned_to))}</span>` : '',
      pr_url: (t) => t.pr_url ? renderPrLink(t.pr_url) : '',
    },
    log: {
      created_at: (l) => `<span class="log-time">${escapeHtml(l.created_at)}</span>`,
      actor: (l) => `<span class="log-actor">${escapeHtml(l.actor)}</span>`,
      action: (l) => `<span class="log-action">${escapeHtml(l.action)}</span>`,
      details: (l) => l.details ? `<span style="color:#484f58">${escapeHtml(l.details.substring(0, 80))}</span>` : '',
    },
  };

  function renderItemColumns(panelName, item) {
    const cols = getOrderedColumns(panelName);
    const renderers = COLUMN_RENDERERS[panelName];
    return cols.map(c => renderers[c.key] ? renderers[c.key](item) : '').join('\n');
  }

  function renderWorkers(workers) {
    const el = document.getElementById('workers-list');
    if (workers.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No workers registered</div>';
      return;
    }
    el.innerHTML = workers.map(w =>
      `<div class="worker-card">${renderItemColumns('workers', w)}</div>`
    ).join('');
  }

  function renderRequests(requests) {
    const el = document.getElementById('requests-list');
    if (requests.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No requests</div>';
      return;
    }
    el.innerHTML = requests.slice(0, 20).map(r =>
      `<div class="request-item">${renderItemColumns('requests', r)}</div>`
    ).join('');
  }

  function renderTasks(tasks) {
    const el = document.getElementById('tasks-list');
    const active = tasks.filter(t => t.status !== 'completed');
    if (active.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No active tasks</div>';
      return;
    }
    el.innerHTML = active.slice(0, 30).map(t =>
      `<div class="task-item">${renderItemColumns('tasks', t)}</div>`
    ).join('');
  }

  function fetchStatus() {
    fetch('/api/status')
      .then(r => r.json())
      .then(data => {
        renderState(data);
        renderLog(data.logs || []);
      })
      .catch(err => console.error('Status fetch failed:', err));
  }

  function renderLog(logs) {
    const el = document.getElementById('log-list');
    el.innerHTML = logs.reverse().slice(0, 50).map(l =>
      `<div class="log-entry">${renderItemColumns('log', l)}</div>`
    ).join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function safeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch {}
    return null;
  }

  function renderPrLink(prUrl) {
    const safe = safeUrl(prUrl);
    if (!safe) return '';
    return `<a href="${safe}" target="_blank" rel="noopener" style="color:#58a6ff">PR</a>`;
  }

  // --- Setup panel ---

  function fetchConfig() {
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        const dirInput = document.getElementById('project-dir');
        const countInput = document.getElementById('worker-count');
        const repoInput = document.getElementById('github-repo');
        const statusEl = document.getElementById('setup-status');
        const toggleBtn = document.getElementById('setup-toggle');
        const body = document.getElementById('setup-body');

        if (cfg.projectDir) {
          dirInput.value = cfg.projectDir;
        }
        if (cfg.numWorkers) {
          countInput.value = cfg.numWorkers;
        }
        if (cfg.githubRepo) {
          repoInput.value = cfg.githubRepo;
          document.getElementById('git-repo-label').textContent = cfg.githubRepo;
          document.getElementById('git-push-btn').disabled = false;
        }

        if (cfg.setupComplete) {
          statusEl.textContent = 'Setup complete';
          statusEl.className = 'done';
          toggleBtn.style.display = '';
          toggleBtn.innerHTML = '&#9660;';
          // Keep panel open so user can change config
        } else {
          statusEl.textContent = 'Not configured';
          statusEl.className = 'pending';
          toggleBtn.style.display = 'none';
          body.classList.remove('collapsed');
        }
      })
      .catch(err => console.error('Config fetch failed:', err));
  }

  function appendSetupLog(line) {
    const output = document.getElementById('setup-output');
    const log = document.getElementById('setup-log');
    output.style.display = '';
    log.textContent += line + '\n';
    output.scrollTop = output.scrollHeight;
  }

  function onSetupComplete(code) {
    setupRunning = false;
    const btn = document.getElementById('launch-btn');
    const statusEl = document.getElementById('setup-status');
    btn.disabled = false;

    if (code === 0) {
      btn.textContent = 'Launch Setup';
      statusEl.textContent = 'Setup complete';
      statusEl.className = 'done';
      appendSetupLog('\n--- Setup finished successfully ---');
      // Refresh state after setup
      fetchStatus();
      // Show toggle button so panel can be collapsed
      const toggleBtn = document.getElementById('setup-toggle');
      toggleBtn.style.display = '';
    } else {
      btn.textContent = 'Retry Setup';
      statusEl.textContent = 'Setup failed';
      statusEl.className = 'pending';
      appendSetupLog('\n--- Setup failed (exit code ' + code + ') ---');
    }
  }

  // Save config without full setup
  document.getElementById('save-config-btn').addEventListener('click', () => {
    const projectDir = document.getElementById('project-dir').value.trim();
    const githubRepo = document.getElementById('github-repo').value.trim();
    const numWorkers = parseInt(document.getElementById('worker-count').value) || 4;
    if (!projectDir) {
      document.getElementById('project-dir').focus();
      return;
    }
    const btn = document.getElementById('save-config-btn');
    const msg = document.getElementById('config-msg');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, githubRepo, numWorkers }),
    }).then(r => r.json()).then(data => {
      btn.disabled = false;
      btn.textContent = 'Save Config';
      msg.style.display = '';
      if (data.ok) {
        msg.textContent = 'Config saved. Relaunch masters to apply.';
        msg.style.color = '#3fb950';
        // Update git panel label
        document.getElementById('git-repo-label').textContent = githubRepo;
        if (githubRepo) document.getElementById('git-push-btn').disabled = false;
      } else {
        msg.textContent = data.error || 'Save failed';
        msg.style.color = '#f85149';
      }
      setTimeout(() => { msg.style.display = 'none'; }, 5000);
    }).catch(err => {
      btn.disabled = false;
      btn.textContent = 'Save Config';
      msg.style.display = '';
      msg.textContent = 'Error: ' + err.message;
      msg.style.color = '#f85149';
    });
  });

  // Launch setup button
  document.getElementById('launch-btn').addEventListener('click', () => {
    if (setupRunning) return;
    const projectDir = document.getElementById('project-dir').value.trim();
    const githubRepo = document.getElementById('github-repo').value.trim();
    const numWorkers = parseInt(document.getElementById('worker-count').value) || 4;
    if (!projectDir) {
      document.getElementById('project-dir').focus();
      return;
    }

    setupRunning = true;
    const btn = document.getElementById('launch-btn');
    const statusEl = document.getElementById('setup-status');
    btn.disabled = true;
    btn.textContent = 'Running...';
    statusEl.textContent = 'Running setup...';
    statusEl.className = 'running';

    // Clear previous output
    document.getElementById('setup-log').textContent = '';
    document.getElementById('setup-output').style.display = '';

    fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, githubRepo, numWorkers }),
    }).then(r => r.json()).then(data => {
      if (!data.ok) {
        appendSetupLog('Error: ' + (data.error || 'Unknown error'));
        setupRunning = false;
        btn.disabled = false;
        btn.textContent = 'Retry Setup';
        statusEl.textContent = 'Setup failed';
        statusEl.className = 'pending';
      }
    }).catch(err => {
      appendSetupLog('Error: ' + err.message);
      setupRunning = false;
      btn.disabled = false;
      btn.textContent = 'Retry Setup';
    });
  });

  // Toggle setup panel collapse/expand
  document.getElementById('setup-toggle').addEventListener('click', () => {
    const body = document.getElementById('setup-body');
    const btn = document.getElementById('setup-toggle');
    body.classList.toggle('collapsed');
    btn.innerHTML = body.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
  });

  // --- Master launch helpers ---

  function launchMaster(btnId, statusId, endpoint) {
    const btn = document.getElementById(btnId);
    const status = document.getElementById(statusId);
    btn.disabled = true;
    btn.textContent = 'Launching...';

    fetch(endpoint, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          status.textContent = 'Terminal opened';
          status.style.cssText = 'color:#3fb950';
          btn.textContent = 'Launch';
          btn.disabled = false;
        } else {
          status.textContent = data.error || 'Failed';
          status.style.cssText = 'color:#d29922';
          btn.textContent = 'Launch';
          btn.disabled = false;
        }
      })
      .catch(err => {
        status.textContent = 'Error: ' + err.message;
        status.style.cssText = 'color:#f85149';
        btn.textContent = 'Launch';
        btn.disabled = false;
      });
  }

  document.getElementById('master1-btn').addEventListener('click', () => {
    launchMaster('master1-btn', 'master1-status', '/api/master1/launch');
  });

  document.getElementById('architect-btn').addEventListener('click', () => {
    launchMaster('architect-btn', 'architect-status', '/api/architect/launch');
  });

  document.getElementById('master3-btn').addEventListener('click', () => {
    launchMaster('master3-btn', 'master3-status', '/api/master3/launch');
  });

  // --- Git push ---

  function appendGitLog(line) {
    const output = document.getElementById('git-output');
    const log = document.getElementById('git-log');
    output.style.display = '';
    log.textContent += line + '\n';
    output.scrollTop = output.scrollHeight;
  }

  function onGitPushComplete(code) {
    gitPushing = false;
    const btn = document.getElementById('git-push-btn');
    const status = document.getElementById('git-push-status');
    btn.disabled = false;
    btn.textContent = 'Push to GitHub';
    if (code === 0) {
      status.textContent = 'Push successful';
      status.style.color = '#3fb950';
    } else {
      status.textContent = 'Push failed (exit ' + code + ')';
      status.style.color = '#f85149';
    }
  }

  document.getElementById('git-push-btn').addEventListener('click', () => {
    if (gitPushing) return;
    gitPushing = true;
    const btn = document.getElementById('git-push-btn');
    const status = document.getElementById('git-push-status');
    btn.disabled = true;
    btn.textContent = 'Pushing...';
    status.textContent = '';
    document.getElementById('git-log').textContent = '';

    fetch('/api/git/push', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (!data.ok) {
          appendGitLog('Error: ' + (data.error || 'Unknown error'));
          gitPushing = false;
          btn.disabled = false;
          btn.textContent = 'Push to GitHub';
          status.textContent = 'Failed';
          status.style.color = '#f85149';
        }
      })
      .catch(err => {
        appendGitLog('Error: ' + err.message);
        gitPushing = false;
        btn.disabled = false;
        btn.textContent = 'Push to GitHub';
      });
  });

  // Submit request
  document.getElementById('request-btn').addEventListener('click', () => {
    const input = document.getElementById('request-input');
    const desc = input.value.trim();
    if (!desc) return;
    fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc }),
    }).then(r => r.json()).then(data => {
      if (data.ok) {
        input.value = '';
        fetchStatus();
      }
    }).catch(err => console.error('Request submit failed:', err));
  });

  document.getElementById('request-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('request-btn').click();
  });

  // Settings panel (right-click on panel header)
  const settingsPanel = document.getElementById('settings-panel');

  function openSettingsPanel(panelName, x, y) {
    const titleEl = settingsPanel.querySelector('.settings-panel-title');
    const itemsEl = settingsPanel.querySelector('.settings-panel-items');
    const titles = { workers: 'Workers', requests: 'Requests', tasks: 'Tasks', log: 'Activity Log' };
    titleEl.textContent = titles[panelName] || panelName;

    itemsEl.innerHTML = '';

    // Color-link submenu
    var currentColor = getPanelLinkColor(panelName);
    var linkItem = document.createElement('div');
    linkItem.className = 'settings-panel-item';
    linkItem.innerHTML = '<span class="settings-icon">&#9679;</span> Link color';
    var colorPicker = document.createElement('div');
    colorPicker.className = 'link-color-picker';
    LINK_COLORS.forEach(function(color, idx) {
      var swatch = document.createElement('span');
      swatch.className = 'link-color-swatch';
      if (color) {
        swatch.style.background = color;
      } else {
        swatch.classList.add('none');
      }
      if (color === currentColor) swatch.classList.add('selected');
      swatch.title = LINK_COLOR_NAMES[idx];
      swatch.addEventListener('click', function(e) {
        e.stopPropagation();
        var links = loadPanelLinks();
        if (color) {
          links[panelName] = color;
        } else {
          delete links[panelName];
        }
        savePanelLinks(links);
        updateAllLinkIndicators();
        closeSettingsPanel();
      });
      colorPicker.appendChild(swatch);
    });
    linkItem.appendChild(colorPicker);
    itemsEl.appendChild(linkItem);

    // Configure columns option
    const columnsItem = document.createElement('div');
    columnsItem.className = 'settings-panel-item';
    columnsItem.innerHTML = '<span class="settings-icon">&#9776;</span> Configure columns';
    columnsItem.addEventListener('click', function() {
      closeSettingsPanel();
      openColumnConfig(panelName);
    });
    itemsEl.appendChild(columnsItem);

    // Reset column order option
    const resetItem = document.createElement('div');
    resetItem.className = 'settings-panel-item';
    resetItem.innerHTML = '<span class="settings-icon">&#8634;</span> Reset column order';
    resetItem.addEventListener('click', function() {
      saveColumnOrder(panelName, PANEL_COLUMNS[panelName].map(c => c.key));
      closeSettingsPanel();
      fetchStatus();
    });
    itemsEl.appendChild(resetItem);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'settings-panel-divider';
    itemsEl.appendChild(divider);

    const popoutItem = document.createElement('div');
    popoutItem.className = 'settings-panel-item';
    popoutItem.innerHTML = '<span class="settings-icon">&#8599;</span> Open in new window';
    popoutItem.addEventListener('click', function() {
      window.open(
        'popout.html?panel=' + encodeURIComponent(panelName),
        'mac10_popout_' + panelName,
        'width=600,height=500,left=' + (window.screenX + 50) + ',top=' + (window.screenY + 50) + ',resizable=yes,scrollbars=yes'
      );
      closeSettingsPanel();
    });
    itemsEl.appendChild(popoutItem);

    settingsPanel.style.display = '';
    // Position within viewport bounds
    const rect = settingsPanel.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    settingsPanel.style.left = Math.min(x, maxX) + 'px';
    settingsPanel.style.top = Math.min(y, maxY) + 'px';
  }

  function closeSettingsPanel() {
    settingsPanel.style.display = 'none';
  }

  // --- Column configuration modal ---
  function openColumnConfig(panelName) {
    const overlay = document.getElementById('column-config-overlay');
    const title = document.getElementById('column-config-title');
    const list = document.getElementById('column-config-list');
    const titles = { workers: 'Workers', requests: 'Requests', tasks: 'Tasks', log: 'Activity Log' };

    title.textContent = (titles[panelName] || panelName) + ' — Column Order';
    overlay.setAttribute('data-panel', panelName);

    const cols = getOrderedColumns(panelName);
    list.innerHTML = '';

    cols.forEach((col, idx) => {
      const row = document.createElement('div');
      row.className = 'column-config-row';
      row.setAttribute('draggable', 'true');
      row.setAttribute('data-key', col.key);

      row.innerHTML =
        '<span class="column-drag-handle">&#9776;</span>' +
        '<span class="column-config-label">' + escapeHtml(col.label) + '</span>' +
        '<span class="column-config-key">' + escapeHtml(col.key) + '</span>';

      // Drag events
      row.addEventListener('dragstart', function(e) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', col.key);
        row.classList.add('dragging');
      });

      row.addEventListener('dragend', function() {
        row.classList.remove('dragging');
        document.querySelectorAll('.column-config-row.drag-over').forEach(el => el.classList.remove('drag-over'));
      });

      row.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const dragging = list.querySelector('.dragging');
        if (dragging && dragging !== row) {
          row.classList.add('drag-over');
        }
      });

      row.addEventListener('dragleave', function() {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', function(e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedKey = e.dataTransfer.getData('text/plain');
        const dragging = list.querySelector('[data-key="' + draggedKey + '"]');
        if (dragging && dragging !== row) {
          const allRows = Array.from(list.children);
          const fromIdx = allRows.indexOf(dragging);
          const toIdx = allRows.indexOf(row);
          if (fromIdx < toIdx) {
            list.insertBefore(dragging, row.nextSibling);
          } else {
            list.insertBefore(dragging, row);
          }
        }
      });

      list.appendChild(row);
    });

    overlay.style.display = 'flex';
  }

  function closeColumnConfig() {
    document.getElementById('column-config-overlay').style.display = 'none';
  }

  function saveColumnConfig() {
    const overlay = document.getElementById('column-config-overlay');
    const panelName = overlay.getAttribute('data-panel');
    const list = document.getElementById('column-config-list');
    const rows = Array.from(list.querySelectorAll('.column-config-row'));
    const order = rows.map(r => r.getAttribute('data-key'));

    saveColumnOrder(panelName, order);
    closeColumnConfig();
    fetchStatus();
  }

  // Wire up column config modal buttons
  document.getElementById('column-config-cancel').addEventListener('click', closeColumnConfig);
  document.getElementById('column-config-save').addEventListener('click', saveColumnConfig);
  document.getElementById('column-config-overlay').addEventListener('click', function(e) {
    if (e.target === this) closeColumnConfig();
  });

  document.querySelectorAll('.panel-header[data-panel]').forEach(function(header) {
    header.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      openSettingsPanel(header.getAttribute('data-panel'), e.clientX, e.clientY);
    });
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.settings-panel')) {
      closeSettingsPanel();
    }
  });

  document.addEventListener('contextmenu', function(e) {
    if (!e.target.closest('.panel-header[data-panel]') && !e.target.closest('.settings-panel')) {
      closeSettingsPanel();
    }
  });

  // Initial load
  fetchConfig();
  fetchStatus();
  connect();
  applyPanelOrder();
  updateAllLinkIndicators();
  initPanelDrag();
})();
