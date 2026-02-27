(function() {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let setupRunning = false;
  let gitPushing = false;

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      document.getElementById('status-indicator').className = 'status-dot connected';
      document.getElementById('status-text').textContent = 'Connected';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = () => {
      document.getElementById('status-indicator').className = 'status-dot disconnected';
      document.getElementById('status-text').textContent = 'Disconnected';
      reconnectTimer = setTimeout(connect, 3000);
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
      } catch {}
    };
  }

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
          ${t.assigned_to ? `→ worker-${t.assigned_to}` : ''}
          ${t.pr_url ? renderPrLink(t.pr_url) : ''}
        </div>
      </div>
    `).join('');
  }

  function fetchStatus() {
    fetch('/api/status')
      .then(r => r.json())
      .then(data => {
        renderState(data);
        renderLog(data.logs || []);
      })
      .catch(() => {});
  }

  function renderLog(logs) {
    const el = document.getElementById('log-list');
    el.innerHTML = logs.reverse().slice(0, 50).map(l => `
      <div class="log-entry">
        <span class="log-time">${l.created_at}</span>
        <span class="log-actor">${l.actor}</span>
        <span class="log-action">${l.action}</span>
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
        return escapeHtml(url);
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
          toggleBtn.innerHTML = '&#9654;';
          body.classList.add('collapsed');
        } else {
          statusEl.textContent = 'Not configured';
          statusEl.className = 'pending';
          toggleBtn.style.display = 'none';
          body.classList.remove('collapsed');
        }
      })
      .catch(() => {});
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
      .catch(() => {
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
    }).catch(() => {});
  });

  document.getElementById('request-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('request-btn').click();
  });

  // Initial load
  fetchConfig();
  fetchStatus();
  connect();
})();
