(function() {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  let setupRunning = false;
  let gitPushing = false;
  let workerChart = null;
  let taskChart = null;

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
    updateCharts(data.workers || [], data.tasks || []);
  }

  function renderWorkers(workers) {
    const el = document.getElementById('workers-list');
    if (workers.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No workers registered</div>';
      return;
    }
    el.innerHTML = workers.map(w => `
      <div class="worker-card">
        <div class="worker-name">Worker ${w.id}</div>
        <span class="worker-status badge-${w.status}">${w.status}</span>
        ${w.domain ? `<div style="font-size:11px;color:#8b949e;margin-top:4px">${escapeHtml(w.domain)}</div>` : ''}
        ${w.current_task_id ? `<div style="font-size:11px;color:#58a6ff;margin-top:2px">Task #${w.current_task_id}</div>` : ''}
      </div>
    `).join('');
  }

  function renderRequests(requests) {
    const el = document.getElementById('requests-list');
    if (requests.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No requests</div>';
      return;
    }
    el.innerHTML = requests.slice(0, 20).map(r => `
      <div class="request-item">
        <span class="req-id">${r.id}</span>
        <span class="worker-status badge-${r.status}">${r.status}</span>
        ${r.tier ? `<span style="font-size:11px;color:#d29922"> T${r.tier}</span>` : ''}
        <div class="req-desc">${escapeHtml(r.description).slice(0, 100)}</div>
      </div>
    `).join('');
  }

  function renderTasks(tasks) {
    const el = document.getElementById('tasks-list');
    const active = tasks.filter(t => t.status !== 'completed');
    if (active.length === 0) {
      el.innerHTML = '<div style="color:#8b949e;font-size:13px">No active tasks</div>';
      return;
    }
    el.innerHTML = active.slice(0, 30).map(t => `
      <div class="task-item">
        <span style="color:#58a6ff">#${t.id}</span>
        <span class="worker-status badge-${t.status}">${t.status}</span>
        <div class="task-subject">${escapeHtml(t.subject)}</div>
        <div class="task-meta">
          ${t.domain ? `[${escapeHtml(t.domain)}]` : ''} T${t.tier}
          ${t.assigned_to ? `→ worker-${escapeHtml(String(t.assigned_to))}` : ''}
          ${t.pr_url ? renderPrLink(t.pr_url) : ''}
        </div>
      </div>
    `).join('');
  }

  // --- Charts ---

  const chartColors = {
    idle: '#8b949e',
    assigned: '#58a6ff',
    running: '#3fb950',
    busy: '#3fb950',
    completed_task: '#bc8cff',
    resetting: '#d29922',
    pending: '#d29922',
    ready: '#58a6ff',
    in_progress: '#58a6ff',
    completed: '#3fb950',
    failed: '#f85149',
    blocked: '#8b949e'
  };

  function countByStatus(items) {
    const counts = {};
    items.forEach(function(item) {
      const s = item.status || 'unknown';
      counts[s] = (counts[s] || 0) + 1;
    });
    return counts;
  }

  function buildChartData(counts, colorMap) {
    const labels = Object.keys(counts);
    const data = labels.map(function(l) { return counts[l]; });
    const colors = labels.map(function(l) { return colorMap[l] || '#484f58'; });
    return { labels: labels, data: data, colors: colors };
  }

  function createDoughnutChart(canvasId, label) {
    var ctx = document.getElementById(canvasId);
    if (!ctx || typeof Chart === 'undefined') return null;
    return new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          data: [],
          backgroundColor: [],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#8b949e', font: { size: 11 }, padding: 12, boxWidth: 12 }
          }
        },
        cutout: '60%'
      }
    });
  }

  function updateChartInstance(chart, counts) {
    if (!chart) return;
    var cd = buildChartData(counts, chartColors);
    chart.data.labels = cd.labels;
    chart.data.datasets[0].data = cd.data;
    chart.data.datasets[0].backgroundColor = cd.colors;
    chart.update('none');
  }

  function updateCharts(workers, tasks) {
    if (typeof Chart === 'undefined') return;
    if (!workerChart) workerChart = createDoughnutChart('worker-chart', 'Workers');
    if (!taskChart) taskChart = createDoughnutChart('task-chart', 'Tasks');
    updateChartInstance(workerChart, countByStatus(workers));
    updateChartInstance(taskChart, countByStatus(tasks));
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
    el.innerHTML = logs.reverse().slice(0, 50).map(l => `
      <div class="log-entry">
        <span class="log-time">${escapeHtml(l.created_at)}</span>
        <span class="log-actor">${escapeHtml(l.actor)}</span>
        <span class="log-action">${escapeHtml(l.action)}</span>
        ${l.details ? `<span style="color:#484f58">${escapeHtml(l.details.substring(0, 80))}</span>` : ''}
      </div>
    `).join('');
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

  document.querySelectorAll('.panel-header[data-panel]').forEach(function(header) {
    header.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      openSettingsPanel(header.getAttribute('data-panel'), e.clientX, e.clientY);
    });
  });

  document.addEventListener('click', function() {
    closeSettingsPanel();
  });

  document.addEventListener('contextmenu', function(e) {
    if (!e.target.closest('.panel-header[data-panel]') && !e.target.closest('.settings-panel')) {
      closeSettingsPanel();
    }
  });

  // --- Hotkey Manager ---

  var HOTKEY_STORAGE_KEY = 'mac10_hotkeys';
  var hotkeyBindings = [];
  var capturedCombo = null;
  var isRecording = false;

  var hotkeyOverlay = document.getElementById('hotkey-overlay');
  var hotkeyCaptureEl = document.getElementById('hotkey-capture');
  var hotkeyActionType = document.getElementById('hotkey-action-type');
  var hotkeyBuiltinAction = document.getElementById('hotkey-builtin-action');
  var hotkeyScriptEl = document.getElementById('hotkey-script');
  var hotkeyAddBtn = document.getElementById('hotkey-add-btn');
  var hotkeyBindingsList = document.getElementById('hotkey-bindings-list');
  var hotkeyCountEl = document.getElementById('hotkey-count');
  var hotkeyBuiltinField = document.querySelector('.hotkey-builtin-field');
  var hotkeyScriptField = document.querySelector('.hotkey-script-field');

  function loadBindings() {
    try {
      var stored = localStorage.getItem(HOTKEY_STORAGE_KEY);
      hotkeyBindings = stored ? JSON.parse(stored) : [];
    } catch (e) {
      hotkeyBindings = [];
    }
  }

  function saveBindings() {
    localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(hotkeyBindings));
  }

  function comboToString(combo) {
    var parts = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.alt) parts.push('Alt');
    if (combo.shift) parts.push('Shift');
    if (combo.meta) parts.push('Meta');
    if (combo.key) parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
    return parts.join(' + ');
  }

  function comboToId(combo) {
    return [
      combo.ctrl ? 'c' : '',
      combo.alt ? 'a' : '',
      combo.shift ? 's' : '',
      combo.meta ? 'm' : '',
      (combo.key || '').toLowerCase()
    ].join('-');
  }

  function matchesCombo(e, combo) {
    return e.ctrlKey === !!combo.ctrl &&
           e.altKey === !!combo.alt &&
           e.shiftKey === !!combo.shift &&
           e.metaKey === !!combo.meta &&
           e.key.toLowerCase() === (combo.key || '').toLowerCase();
  }

  function executeBuiltinAction(action) {
    switch (action) {
      case 'focus:request':
        document.getElementById('request-input').focus();
        break;
      case 'submit:request':
        document.getElementById('request-btn').click();
        break;
      case 'toggle:setup':
        document.getElementById('setup-toggle').click();
        break;
      case 'toggle:hotkeys':
        toggleHotkeyManager();
        break;
      case 'scroll:top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'scroll:bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        break;
    }
  }

  function executeBinding(binding) {
    if (binding.type === 'builtin') {
      executeBuiltinAction(binding.action);
    } else if (binding.type === 'script') {
      try {
        new Function(binding.action)();
      } catch (err) {
        console.error('Hotkey script error:', err);
      }
    }
  }

  function renderBindings() {
    if (hotkeyBindings.length === 0) {
      hotkeyBindingsList.innerHTML = '<div class="hotkey-empty">No hotkeys configured. Add one above.</div>';
      hotkeyCountEl.textContent = '0 bindings';
      return;
    }
    hotkeyCountEl.textContent = hotkeyBindings.length + ' binding' + (hotkeyBindings.length === 1 ? '' : 's');
    hotkeyBindingsList.innerHTML = hotkeyBindings.map(function(b, i) {
      var actionLabel = b.type === 'builtin'
        ? '<code>' + escapeHtml(b.action) + '</code>'
        : 'Script: ' + escapeHtml(b.action.substring(0, 50)) + (b.action.length > 50 ? '...' : '');
      return '<div class="hotkey-binding-row">' +
        '<span class="hotkey-binding-keys">' + escapeHtml(comboToString(b.combo)) + '</span>' +
        '<span class="hotkey-binding-action">' + actionLabel + '</span>' +
        '<button class="hotkey-binding-delete" data-index="' + i + '" title="Remove">&times;</button>' +
        '</div>';
    }).join('');
  }

  function toggleHotkeyManager() {
    if (hotkeyOverlay.style.display === 'none') {
      hotkeyOverlay.style.display = '';
      renderBindings();
    } else {
      hotkeyOverlay.style.display = 'none';
      stopRecording();
    }
  }

  function stopRecording() {
    isRecording = false;
    hotkeyCaptureEl.classList.remove('recording');
    if (!capturedCombo) {
      hotkeyCaptureEl.textContent = 'Click to record...';
    }
  }

  // Open/close hotkey manager
  document.getElementById('hotkey-trigger-btn').addEventListener('click', function() {
    toggleHotkeyManager();
  });

  document.getElementById('hotkey-close-btn').addEventListener('click', function() {
    hotkeyOverlay.style.display = 'none';
    stopRecording();
  });

  // Close on overlay click (not modal)
  hotkeyOverlay.addEventListener('click', function(e) {
    if (e.target === hotkeyOverlay) {
      hotkeyOverlay.style.display = 'none';
      stopRecording();
    }
  });

  // Toggle between builtin and script fields
  hotkeyActionType.addEventListener('change', function() {
    if (hotkeyActionType.value === 'script') {
      hotkeyBuiltinField.style.display = 'none';
      hotkeyScriptField.style.display = '';
    } else {
      hotkeyBuiltinField.style.display = '';
      hotkeyScriptField.style.display = 'none';
    }
  });

  // Key capture
  hotkeyCaptureEl.addEventListener('click', function() {
    isRecording = true;
    capturedCombo = null;
    hotkeyCaptureEl.textContent = 'Press keys...';
    hotkeyCaptureEl.classList.add('recording');
    hotkeyCaptureEl.focus();
  });

  hotkeyCaptureEl.addEventListener('keydown', function(e) {
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();

    // Ignore bare modifier keys
    if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(e.key) !== -1) return;

    capturedCombo = {
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
      key: e.key
    };

    hotkeyCaptureEl.textContent = comboToString(capturedCombo);
    isRecording = false;
    hotkeyCaptureEl.classList.remove('recording');
  });

  // Add binding
  hotkeyAddBtn.addEventListener('click', function() {
    if (!capturedCombo) return;

    // Check for duplicate
    var newId = comboToId(capturedCombo);
    for (var i = 0; i < hotkeyBindings.length; i++) {
      if (comboToId(hotkeyBindings[i].combo) === newId) {
        hotkeyBindings.splice(i, 1);
        break;
      }
    }

    var binding = { combo: capturedCombo };
    if (hotkeyActionType.value === 'script') {
      var script = hotkeyScriptEl.value.trim();
      if (!script) return;
      binding.type = 'script';
      binding.action = script;
    } else {
      binding.type = 'builtin';
      binding.action = hotkeyBuiltinAction.value;
    }

    hotkeyBindings.push(binding);
    saveBindings();
    renderBindings();

    // Reset form
    capturedCombo = null;
    hotkeyCaptureEl.textContent = 'Click to record...';
    hotkeyScriptEl.value = '';
  });

  // Delete binding (event delegation)
  hotkeyBindingsList.addEventListener('click', function(e) {
    var deleteBtn = e.target.closest('.hotkey-binding-delete');
    if (!deleteBtn) return;
    var idx = parseInt(deleteBtn.getAttribute('data-index'), 10);
    if (idx >= 0 && idx < hotkeyBindings.length) {
      hotkeyBindings.splice(idx, 1);
      saveBindings();
      renderBindings();
    }
  });

  // Global hotkey listener
  document.addEventListener('keydown', function(e) {
    // Don't fire hotkeys when typing in inputs (unless it has modifiers)
    var target = e.target;
    var isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

    // Open hotkey manager with ? key (when not in an input)
    if (e.key === '?' && !isInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
      toggleHotkeyManager();
      e.preventDefault();
      return;
    }

    // Close hotkey manager with Escape
    if (e.key === 'Escape' && hotkeyOverlay.style.display !== 'none') {
      hotkeyOverlay.style.display = 'none';
      stopRecording();
      e.preventDefault();
      return;
    }

    // Skip if recording keys in capture box
    if (isRecording) return;

    // Check all bindings
    for (var i = 0; i < hotkeyBindings.length; i++) {
      var b = hotkeyBindings[i];
      if (matchesCombo(e, b.combo)) {
        // For combos with modifiers, always fire. For bare keys, skip if in input.
        var hasModifier = b.combo.ctrl || b.combo.alt || b.combo.meta;
        if (!hasModifier && isInput) continue;
        e.preventDefault();
        executeBinding(b);
        return;
      }
    }
  });

  // Load bindings on startup
  loadBindings();

  // Initial load
  fetchConfig();
  fetchStatus();
  connect();
})();
