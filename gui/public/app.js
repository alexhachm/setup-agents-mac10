(function() {
  'use strict';

  const MAX_RECONNECT_DELAY = 30000;

  // --- Multi-tab state ---
  const tabs = new Map(); // tabId -> tab state object
  let activeTabId = null;
  let tabIdCounter = 0;
  let instancePollTimer = null;

  // The "hub" port is the one the browser loaded from
  const hubPort = parseInt(location.port) || (location.protocol === 'https:' ? 443 : 80);

  function createTabState(port, name, projectDir) {
    return {
      id: ++tabIdCounter,
      port,
      name,
      projectDir: projectDir || '',
      ws: null,
      connected: false,
      reconnectTimer: null,
      reconnectDelay: 1000,
      // Cached state from WS
      state: { requests: [], workers: [], tasks: [] },
      config: null,
      presets: [],
      setupRunning: false,
      gitPushing: false,
    };
  }

  function activeTab() {
    return tabs.get(activeTabId) || null;
  }

  // --- Tab-scoped fetch ---
  function tabFetch(tab, path, opts) {
    const base = `${location.protocol}//${location.hostname}:${tab.port}`;
    return fetch(base + path, opts);
  }

  // --- WebSocket per tab ---
  function connectTab(tab) {
    if (tab.ws && (tab.ws.readyState === WebSocket.OPEN || tab.ws.readyState === WebSocket.CONNECTING)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    tab.ws = new WebSocket(`${protocol}//${location.hostname}:${tab.port}`);

    tab.ws.onopen = () => {
      tab.connected = true;
      tab.reconnectDelay = 1000;
      if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
      renderTabBar();
      if (tab.id === activeTabId) updateConnectionIndicator(true);
    };

    tab.ws.onclose = () => {
      tab.connected = false;
      renderTabBar();
      if (tab.id === activeTabId) updateConnectionIndicator(false);
      tab.reconnectTimer = setTimeout(() => connectTab(tab), tab.reconnectDelay);
      tab.reconnectDelay = Math.min(tab.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    };

    tab.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init' || msg.type === 'state') {
          tab.state = msg.data;
          if (tab.id === activeTabId) renderState(msg.data);
        } else if (msg.type === 'request_created') {
          if (tab.id === activeTabId) fetchTabStatus(tab);
        } else if (msg.type === 'setup_log') {
          if (tab.id === activeTabId) appendSetupLog(msg.line);
        } else if (msg.type === 'setup_complete') {
          tab.setupRunning = false;
          if (tab.id === activeTabId) onSetupComplete(msg.code);
        } else if (msg.type === 'git_push_log') {
          if (tab.id === activeTabId) appendGitLog(msg.line);
        } else if (msg.type === 'git_push_complete') {
          tab.gitPushing = false;
          if (tab.id === activeTabId) onGitPushComplete(msg.code);
        }
      } catch (e) { console.error('WS parse error:', e); }
    };
  }

  function disconnectTab(tab) {
    if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    if (tab.ws) { tab.ws.onclose = null; tab.ws.close(); tab.ws = null; }
    tab.connected = false;
  }

  function updateConnectionIndicator(connected) {
    document.getElementById('status-indicator').className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
    document.getElementById('status-text').textContent = connected ? 'Connected' : 'Disconnected';
  }

  // --- Tab bar rendering ---
  function renderTabBar() {
    const list = document.getElementById('tab-list');
    list.innerHTML = '';
    for (const [id, tab] of tabs) {
      const el = document.createElement('div');
      el.className = 'tab-item' + (id === activeTabId ? ' active' : '');
      el.innerHTML =
        `<span class="tab-dot ${tab.connected ? 'connected' : 'disconnected'}"></span>` +
        `<span class="tab-name">${escapeHtml(tab.name)}</span>` +
        `<button class="tab-close" title="Close tab">&times;</button>`;
      el.querySelector('.tab-name').addEventListener('click', () => switchTab(id));
      el.querySelector('.tab-dot').addEventListener('click', () => switchTab(id));
      el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
      list.appendChild(el);
    }
  }

  function switchTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeTabId = tabId;
    const tab = tabs.get(tabId);
    renderTabBar();
    updateConnectionIndicator(tab.connected);
    // Re-render all panels from cached state
    renderState(tab.state);
    fetchTabConfig(tab);
    fetchTabPresets(tab);
    fetchTabStatus(tab);
  }

  function addTab(port, name, projectDir) {
    // Check if tab already exists for this port
    for (const [id, tab] of tabs) {
      if (tab.port === port) {
        return id;
      }
    }
    const tab = createTabState(port, name, projectDir);
    tabs.set(tab.id, tab);
    connectTab(tab);
    renderTabBar();
    return tab.id;
  }

  function closeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    disconnectTab(tab);
    tabs.delete(tabId);
    if (activeTabId === tabId) {
      // Switch to first available tab
      const first = tabs.keys().next();
      if (!first.done) {
        switchTab(first.value);
      } else {
        activeTabId = null;
        renderTabBar();
        clearPanels();
      }
    } else {
      renderTabBar();
    }
  }

  function clearPanels() {
    renderState({ requests: [], workers: [], tasks: [] });
    document.getElementById('log-list').innerHTML = '';
  }

  // --- Instance polling ---
  function pollInstances() {
    const hubBase = `${location.protocol}//${location.hostname}:${hubPort}`;
    fetch(hubBase + '/api/instances')
      .then(r => r.json())
      .then(instances => {
        const activePorts = new Set();
        for (const inst of instances) {
          activePorts.add(inst.port);
          addTab(inst.port, inst.name, inst.projectDir);
        }
        // Remove tabs for dead instances (except if manually added)
        for (const [id, tab] of tabs) {
          if (!activePorts.has(tab.port) && !tab.connected) {
            tabs.delete(id);
            if (activeTabId === id) {
              const first = tabs.keys().next();
              activeTabId = first.done ? null : first.value;
            }
          }
        }
        renderTabBar();
        // Auto-switch to first tab if none active
        if (!activeTabId && tabs.size > 0) {
          switchTab(tabs.keys().next().value);
        }
      })
      .catch(err => console.error('Instance poll failed:', err));
  }

  // --- Render functions (unchanged logic, operate on active tab data) ---

  function renderState(data) {
    renderWorkers(data.workers || []);
    renderRequests(data.requests || []);
    renderTasks(data.tasks || []);
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
          ${t.assigned_to ? `&rarr; worker-${escapeHtml(String(t.assigned_to))}` : ''}
          ${t.pr_url ? renderPrLink(t.pr_url) : ''}
        </div>
      </div>
    `).join('');
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

  // --- Tab-scoped data fetchers ---

  function fetchTabStatus(tab) {
    tabFetch(tab, '/api/status')
      .then(r => r.json())
      .then(data => {
        tab.state = data;
        if (tab.id === activeTabId) {
          renderState(data);
          renderLog(data.logs || []);
        }
      })
      .catch(err => console.error('Status fetch failed:', err));
  }

  function fetchTabConfig(tab) {
    tabFetch(tab, '/api/config')
      .then(r => r.json())
      .then(cfg => {
        tab.config = cfg;
        if (tab.id !== activeTabId) return;

        const dirInput = document.getElementById('project-dir');
        const countInput = document.getElementById('worker-count');
        const repoInput = document.getElementById('github-repo');
        const statusEl = document.getElementById('setup-status');
        const toggleBtn = document.getElementById('setup-toggle');
        const body = document.getElementById('setup-body');

        if (cfg.projectDir) dirInput.value = cfg.projectDir;
        if (cfg.numWorkers) countInput.value = cfg.numWorkers;
        if (cfg.githubRepo) {
          repoInput.value = cfg.githubRepo;
          document.getElementById('git-repo-label').textContent = cfg.githubRepo;
          document.getElementById('git-push-btn').disabled = false;
        } else {
          repoInput.value = '';
          document.getElementById('git-repo-label').textContent = '';
          document.getElementById('git-push-btn').disabled = true;
        }

        if (cfg.setupComplete) {
          statusEl.textContent = 'Setup complete';
          statusEl.className = 'done';
          toggleBtn.style.display = '';
          toggleBtn.innerHTML = '&#9660;';
        } else {
          statusEl.textContent = 'Not configured';
          statusEl.className = 'pending';
          toggleBtn.style.display = 'none';
          body.classList.remove('collapsed');
        }
      })
      .catch(err => console.error('Config fetch failed:', err));
  }

  function fetchTabPresets(tab) {
    tabFetch(tab, '/api/presets')
      .then(r => r.json())
      .then(data => {
        tab.presets = data;
        if (tab.id === activeTabId) renderPresets(data);
      })
      .catch(err => console.error('Presets fetch failed:', err));
  }

  // --- Presets ---

  function renderPresets(presetList) {
    const sel = document.getElementById('preset-select');
    const current = sel.value;
    sel.innerHTML = '<option value="">-- New --</option>';
    presetList.forEach(p => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    if (current && sel.querySelector(`option[value="${current}"]`)) {
      sel.value = current;
    }
    document.getElementById('preset-delete-btn').disabled = !sel.value;
  }

  document.getElementById('preset-select').addEventListener('change', (e) => {
    const id = e.target.value;
    document.getElementById('preset-delete-btn').disabled = !id;
    if (!id) return;
    const tab = activeTab();
    if (!tab) return;
    const preset = tab.presets.find(p => String(p.id) === id);
    if (!preset) return;
    document.getElementById('project-dir').value = preset.project_dir;
    document.getElementById('github-repo').value = preset.github_repo;
    document.getElementById('worker-count').value = preset.num_workers;
  });

  document.getElementById('preset-delete-btn').addEventListener('click', () => {
    const sel = document.getElementById('preset-select');
    const id = sel.value;
    if (!id) return;
    if (!confirm('Delete this preset?')) return;
    const tab = activeTab();
    if (!tab) return;
    tabFetch(tab, '/api/presets/' + id, { method: 'DELETE' })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          sel.value = '';
          fetchTabPresets(tab);
        }
      })
      .catch(err => console.error('Preset delete failed:', err));
  });

  // --- Setup panel ---

  function appendSetupLog(line) {
    const output = document.getElementById('setup-output');
    const log = document.getElementById('setup-log');
    output.style.display = '';
    log.textContent += line + '\n';
    output.scrollTop = output.scrollHeight;
  }

  function onSetupComplete(code) {
    const btn = document.getElementById('launch-btn');
    const statusEl = document.getElementById('setup-status');
    btn.disabled = false;

    if (code === 0) {
      btn.textContent = 'Launch Setup';
      statusEl.textContent = 'Setup complete';
      statusEl.className = 'done';
      appendSetupLog('\n--- Setup finished successfully ---');
      const tab = activeTab();
      if (tab) {
        fetchTabStatus(tab);
        fetchTabPresets(tab);
      }
      const toggleBtn = document.getElementById('setup-toggle');
      toggleBtn.style.display = '';
    } else {
      btn.textContent = 'Retry Setup';
      statusEl.textContent = 'Setup failed';
      statusEl.className = 'pending';
      appendSetupLog('\n--- Setup failed (exit code ' + code + ') ---');
    }
  }

  document.getElementById('save-config-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
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

    tabFetch(tab, '/api/config', {
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
        document.getElementById('git-repo-label').textContent = githubRepo;
        if (githubRepo) document.getElementById('git-push-btn').disabled = false;
        fetchTabPresets(tab);
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

  document.getElementById('launch-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || tab.setupRunning) return;
    const projectDir = document.getElementById('project-dir').value.trim();
    const githubRepo = document.getElementById('github-repo').value.trim();
    const numWorkers = parseInt(document.getElementById('worker-count').value) || 4;
    if (!projectDir) {
      document.getElementById('project-dir').focus();
      return;
    }

    tab.setupRunning = true;
    const btn = document.getElementById('launch-btn');
    const statusEl = document.getElementById('setup-status');
    btn.disabled = true;
    btn.textContent = 'Running...';
    statusEl.textContent = 'Running setup...';
    statusEl.className = 'running';

    document.getElementById('setup-log').textContent = '';
    document.getElementById('setup-output').style.display = '';

    tabFetch(tab, '/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, githubRepo, numWorkers }),
    }).then(r => r.json()).then(data => {
      if (!data.ok) {
        appendSetupLog('Error: ' + (data.error || 'Unknown error'));
        tab.setupRunning = false;
        btn.disabled = false;
        btn.textContent = 'Retry Setup';
        statusEl.textContent = 'Setup failed';
        statusEl.className = 'pending';
      }
    }).catch(err => {
      appendSetupLog('Error: ' + err.message);
      tab.setupRunning = false;
      btn.disabled = false;
      btn.textContent = 'Retry Setup';
    });
  });

  document.getElementById('setup-toggle').addEventListener('click', () => {
    const body = document.getElementById('setup-body');
    const btn = document.getElementById('setup-toggle');
    body.classList.toggle('collapsed');
    btn.innerHTML = body.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
  });

  // --- Master launch helpers ---

  function launchMaster(btnId, statusId, endpoint) {
    const tab = activeTab();
    if (!tab) return;
    const btn = document.getElementById(btnId);
    const status = document.getElementById(statusId);
    btn.disabled = true;
    btn.textContent = 'Launching...';

    tabFetch(tab, endpoint, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          status.textContent = 'Terminal opened';
          status.style.cssText = 'color:#3fb950';
        } else {
          status.textContent = data.error || 'Failed';
          status.style.cssText = 'color:#d29922';
        }
        btn.textContent = 'Launch';
        btn.disabled = false;
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
    const tab = activeTab();
    if (!tab || tab.gitPushing) return;
    tab.gitPushing = true;
    const btn = document.getElementById('git-push-btn');
    const status = document.getElementById('git-push-status');
    btn.disabled = true;
    btn.textContent = 'Pushing...';
    status.textContent = '';
    document.getElementById('git-log').textContent = '';

    tabFetch(tab, '/api/git/push', { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (!data.ok) {
          appendGitLog('Error: ' + (data.error || 'Unknown error'));
          tab.gitPushing = false;
          btn.disabled = false;
          btn.textContent = 'Push to GitHub';
          status.textContent = 'Failed';
          status.style.color = '#f85149';
        }
      })
      .catch(err => {
        appendGitLog('Error: ' + err.message);
        tab.gitPushing = false;
        btn.disabled = false;
        btn.textContent = 'Push to GitHub';
      });
  });

  // --- Submit request ---

  document.getElementById('request-btn').addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    const input = document.getElementById('request-input');
    const desc = input.value.trim();
    if (!desc) return;
    tabFetch(tab, '/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc }),
    }).then(r => r.json()).then(data => {
      if (data.ok) {
        input.value = '';
        fetchTabStatus(tab);
      }
    }).catch(err => console.error('Request submit failed:', err));
  });

  document.getElementById('request-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('request-btn').click();
  });

  // --- Settings panel (right-click on panel header) ---
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
      const tab = activeTab();
      const portParam = tab ? '&port=' + tab.port : '';
      window.open(
        'popout.html?panel=' + encodeURIComponent(panelName) + portParam,
        'mac10_popout_' + panelName + (tab ? '_' + tab.port : ''),
        'width=600,height=500,left=' + (window.screenX + 50) + ',top=' + (window.screenY + 50) + ',resizable=yes,scrollbars=yes'
      );
      closeSettingsPanel();
    });
    itemsEl.appendChild(popoutItem);

    settingsPanel.style.display = '';
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

  document.addEventListener('click', function() { closeSettingsPanel(); });
  document.addEventListener('contextmenu', function(e) {
    if (!e.target.closest('.panel-header[data-panel]') && !e.target.closest('.settings-panel')) {
      closeSettingsPanel();
    }
  });

  // --- Add project modal ---

  const modal = document.getElementById('add-project-modal');
  let modalPresets = [];

  function fetchModalPresets() {
    const hubBase = `${location.protocol}//${location.hostname}:${hubPort}`;
    return fetch(hubBase + '/api/presets')
      .then(r => r.json())
      .then(data => {
        modalPresets = data;
        renderModalPresets();
      })
      .catch(err => console.error('Modal presets fetch failed:', err));
  }

  function renderModalPresets() {
    const sel = document.getElementById('modal-preset-select');
    sel.innerHTML = '<option value="">-- New --</option>';
    modalPresets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }

  document.getElementById('modal-preset-select').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) return;
    const preset = modalPresets.find(p => String(p.id) === id);
    if (!preset) return;
    document.getElementById('modal-project-dir').value = preset.project_dir;
    document.getElementById('modal-github-repo').value = preset.github_repo || '';
    document.getElementById('modal-worker-count').value = preset.num_workers || 4;
  });

  document.getElementById('add-tab-btn').addEventListener('click', () => {
    modal.style.display = '';
    document.getElementById('modal-preset-select').value = '';
    document.getElementById('modal-project-dir').value = '';
    document.getElementById('modal-github-repo').value = '';
    document.getElementById('modal-worker-count').value = '4';
    document.getElementById('modal-save-preset').checked = true;
    document.getElementById('modal-error').style.display = 'none';
    document.getElementById('modal-launch-btn').disabled = false;
    document.getElementById('modal-launch-btn').textContent = 'Launch';
    fetchModalPresets();
    document.getElementById('modal-project-dir').focus();
  });

  document.getElementById('modal-cancel-btn').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  document.getElementById('modal-launch-btn').addEventListener('click', () => {
    const dir = document.getElementById('modal-project-dir').value.trim();
    const repo = document.getElementById('modal-github-repo').value.trim();
    const workers = parseInt(document.getElementById('modal-worker-count').value) || 4;
    const savePreset = document.getElementById('modal-save-preset').checked;
    const errEl = document.getElementById('modal-error');
    const btn = document.getElementById('modal-launch-btn');

    if (!dir) {
      errEl.textContent = 'Project directory is required';
      errEl.style.display = '';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Launching...';
    errEl.style.display = 'none';

    // Save preset via hub before launching (if checked)
    const hubBase = `${location.protocol}//${location.hostname}:${hubPort}`;
    const presetPromise = savePreset && dir
      ? fetch(hubBase + '/api/presets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: repo || dir.split('/').pop(),
            projectDir: dir,
            githubRepo: repo,
            numWorkers: workers,
          }),
        }).catch(() => {}) // non-fatal
      : Promise.resolve();

    presetPromise.then(() => {
      return fetch(hubBase + '/api/instances/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDir: dir, githubRepo: repo, numWorkers: workers }),
      });
    }).then(r => r.json()).then(data => {
      btn.disabled = false;
      btn.textContent = 'Launch';
      if (data.ok) {
        modal.style.display = 'none';
        const tabId = addTab(data.port, data.name, dir);
        switchTab(tabId);
      } else if (data.port) {
        // Already running -- just open the tab
        modal.style.display = 'none';
        const tabId = addTab(data.port, dir.split('/').pop(), dir);
        switchTab(tabId);
      } else {
        errEl.textContent = data.error || 'Launch failed';
        errEl.style.display = '';
      }
    }).catch(err => {
      btn.disabled = false;
      btn.textContent = 'Launch';
      errEl.textContent = 'Error: ' + err.message;
      errEl.style.display = '';
    });
  });

  // --- Initial load ---
  // Poll instances from the hub coordinator, create tabs for each
  pollInstances();
  instancePollTimer = setInterval(pollInstances, 5000);
})();
