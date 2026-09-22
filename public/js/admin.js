// Head Admin & Sub Admin Portal Controller
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // State
  let currentUser = null;
  let activeTab = 'overview';
  let cachedTeams = [];
  let currentViewingQrTeamId = null;

  // DOM Elements
  const loginView = document.getElementById('admin-login-view');
  const headAdminView = document.getElementById('head-admin-view');
  const subAdminScannerView = document.getElementById('sub-admin-scanner-view');
  const loginForm = document.getElementById('admin-login-form');
  const loginAlert = document.getElementById('admin-login-alert');
  const btnLogout = document.getElementById('btn-admin-logout');
  const btnSwitchScanner = document.getElementById('btn-switch-scanner');
  const btnSoundToggle = document.getElementById('btn-sound-toggle');
  const portalUserRoleLabel = document.getElementById('portal-user-role-label');

  // 1. Audio Toggle
  btnSoundToggle.addEventListener('click', () => {
    window.soundSystem.muted = !window.soundSystem.muted;
    btnSoundToggle.textContent = window.soundSystem.muted ? '🔇 AUDIO OFF' : '🔊 AUDIO ON';
    btnSoundToggle.classList.toggle('btn-secondary', !window.soundSystem.muted);
    btnSoundToggle.classList.toggle('btn-outline-crimson', window.soundSystem.muted);
  });

  // 2. Check Existing Session
  async function checkSession() {
    const res = await api.getMe();
    if (res.success && res.user && (res.user.role === 'HEAD_ADMIN' || res.user.role === 'SUB_ADMIN')) {
      currentUser = res.user;
      renderAuthenticatedView();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginView.style.display = 'flex';
    headAdminView.style.display = 'none';
    subAdminScannerView.style.display = 'none';
    btnLogout.style.display = 'none';
    btnSwitchScanner.style.display = 'none';
    portalUserRoleLabel.textContent = 'COMMAND & ACCESS CONTROL SYSTEM';
  }

  function renderAuthenticatedView() {
    loginView.style.display = 'none';
    btnLogout.style.display = 'inline-flex';

    if (currentUser.role === 'HEAD_ADMIN') {
      portalUserRoleLabel.textContent = `HEAD ADMIN COMMAND CENTER — [${currentUser.username}]`;
      headAdminView.style.display = 'grid';
      subAdminScannerView.style.display = 'none';
      btnSwitchScanner.style.display = 'inline-flex';
      btnSwitchScanner.textContent = '📷 TEST ROOM SCANNER';

      loadOverview();
      setupTabs();
      setupModals();
    } else if (currentUser.role === 'SUB_ADMIN') {
      portalUserRoleLabel.textContent = `VOLUNTEER CHECKPOINT — ${currentUser.name || currentUser.username} [${currentUser.assigned_room}]`;
      headAdminView.style.display = 'none';
      subAdminScannerView.style.display = 'block';
      btnSwitchScanner.style.display = 'none';

      document.getElementById('scanner-volunteer-name').textContent = `Volunteer: ${currentUser.name || currentUser.username}`;
      window.scanner.init(currentUser.assigned_room);
    }
  }

  // Toggle between Command Center and Scanner for Head Admin
  btnSwitchScanner.addEventListener('click', () => {
    if (headAdminView.style.display !== 'none') {
      headAdminView.style.display = 'none';
      subAdminScannerView.style.display = 'block';
      btnSwitchScanner.textContent = '📊 BACK TO COMMAND CENTER';
      window.scanner.init('POLICE');
    } else {
      headAdminView.style.display = 'grid';
      subAdminScannerView.style.display = 'none';
      btnSwitchScanner.textContent = '📷 TEST ROOM SCANNER';
      loadOverview();
    }
  });

  // 3. Login Submit
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginAlert.style.display = 'none';

    const username = document.getElementById('admin-username').value;
    const password = document.getElementById('admin-password').value;

    const res = await api.adminLogin(username, password);
    if (!res.success) {
      loginAlert.textContent = res.message || 'Invalid Credentials. Access Denied.';
      loginAlert.style.display = 'block';
      window.soundSystem.playDeniedBuzzer();
      return;
    }

    window.soundSystem.playSuccessBeep();
    currentUser = res.user;
    renderAuthenticatedView();
  });

  // 4. Logout
  btnLogout.addEventListener('click', async () => {
    await api.logout();
    currentUser = null;
    showLogin();
  });

  // 5. Head Admin Tab Switching
  function setupTabs() {
    const tabButtons = document.querySelectorAll('.admin-nav-item');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const tab = btn.getAttribute('data-tab');
        activeTab = tab;

        document.querySelectorAll('.admin-tab-content').forEach(c => c.style.display = 'none');
        const target = document.getElementById(`tab-${tab}`);
        if (target) target.style.display = 'block';

        if (tab === 'overview') loadOverview();
        if (tab === 'teams') loadTeams();
        if (tab === 'rounds') loadRounds();
        if (tab === 'volunteers') loadVolunteers();
        if (tab === 'logs') loadLogs();
      });
    });
  }

  // 6. Tab: Overview Data Loader
  async function loadOverview() {
    const res = await api.getAdminOverview();
    if (!res.success) return;

    // Metrics
    document.getElementById('stat-total-teams').textContent = res.stats.total_teams;
    document.getElementById('stat-active-teams').textContent = res.stats.active_teams;
    document.getElementById('stat-eliminated-teams').textContent = res.stats.eliminated_teams;
    document.getElementById('stat-teams-inside').textContent = res.stats.teams_inside;
    document.getElementById('stat-completed-visits').textContent = res.stats.completed_visits;
    document.getElementById('stat-current-round').textContent = res.stats.current_round;

    // Rooms Occupancy
    const roomsContainer = document.getElementById('admin-rooms-occupancy');
    roomsContainer.innerHTML = (res.room_status || []).map(r => {
      const occupied = r.occupied && r.current_team;
      const statusBadge = occupied
        ? '<span class="badge badge-crimson">OCCUPIED</span>'
        : '<span class="badge badge-active">AVAILABLE</span>';

      let occupantDetails = '<div class="mono text-dim" style="font-size: 0.85rem; margin-top: 0.5rem;">No team inside currently</div>';
      if (occupied) {
        const mins = String(Math.floor(r.current_team.remaining_seconds / 60)).padStart(2, '0');
        const secs = String(r.current_team.remaining_seconds % 60).padStart(2, '0');
        occupantDetails = `
          <div style="margin-top: 0.5rem;">
            <div style="font-size: 1.1rem; font-weight: 700; color: #fff;">${r.current_team.team_name} (${r.current_team.team_id})</div>
            <div class="mono text-crimson" style="font-size: 1.3rem; font-weight: 800; margin-top: 0.2rem;">⏱️ ${mins}:${secs} REMAINING</div>
          </div>
        `;
      }

      return `
        <div class="room-card ${occupied ? 'occupied' : ''} tactical-frame">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h4 style="font-size: 1rem;">${r.room_name}</h4>
            ${statusBadge}
          </div>
          ${occupantDetails}
        </div>
      `;
    }).join('');

    // Leaderboard table on overview
    loadOverviewLeaderboard();
  }

  async function loadOverviewLeaderboard() {
    const res = await api.getLeaderboard();
    if (!res.success) return;

    const tbody = document.getElementById('overview-leaderboard-tbody');
    tbody.innerHTML = res.teams.map((t, idx) => {
      const isEliminated = t.status === 'ELIMINATED';
      return `
        <tr>
          <td><strong class="mono">#${idx + 1}</strong></td>
          <td><span class="mono">${t.team_id}</span></td>
          <td><strong>${t.team_name}</strong></td>
          <td>${isEliminated ? '<span class="badge badge-eliminated">ELIMINATED</span>' : '<span class="badge badge-active">ACTIVE</span>'}</td>
          <td><span class="mono text-crimson" style="font-size: 1.1rem; font-weight: 800;">${t.score}</span></td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              <input type="number" class="score-input" id="score-input-${t.id}" value="${t.score}">
              <button class="btn btn-secondary btn-sm" onclick="handleQuickScoreUpdate(${t.id})">SAVE</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Quick Score Update
  window.handleQuickScoreUpdate = async (teamId) => {
    const input = document.getElementById(`score-input-${teamId}`);
    if (!input) return;
    const newScore = parseInt(input.value, 10);
    const res = await api.updateScore(teamId, newScore);
    if (res.success) {
      window.soundSystem.playSuccessBeep();
      loadOverview();
    } else {
      alert(res.message || 'Failed to update score.');
    }
  };

  // 7. Tab: Teams Management
  async function loadTeams() {
    const res = await api.getAdminTeams();
    if (!res.success) return;

    cachedTeams = res.teams;
    renderTeamsTable(cachedTeams);
  }

  function renderTeamsTable(teams) {
    const tbody = document.getElementById('teams-management-tbody');
    if (!tbody) return;

    if (teams.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-dim" style="text-align: center; padding: 2rem;">No teams registered.</td></tr>`;
      return;
    }

    tbody.innerHTML = teams.map(t => {
      const isEliminated = t.status === 'ELIMINATED';
      return `
        <tr>
          <td><strong class="mono">${t.team_id}</strong></td>
          <td><strong>${t.team_name}</strong></td>
          <td><span class="mono text-crimson" style="font-weight: 800; font-size: 1.05rem;">${t.score}</span></td>
          <td>${isEliminated ? '<span class="badge badge-eliminated">ELIMINATED</span>' : '<span class="badge badge-active">ACTIVE</span>'}</td>
          <td><span class="mono">${t.total_room_visits || 0} visits</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="openQrModal(${t.id}, '${t.team_id}', '${t.team_name}')">
              📱 QR BADGE
            </button>
          </td>
          <td>
            <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
              <button class="btn btn-secondary btn-sm" onclick="openEditTeamModal(${t.id})">EDIT</button>
              ${isEliminated 
                ? `<button class="btn btn-secondary btn-sm" style="color: var(--status-active);" onclick="handleRestoreTeam(${t.id}, '${t.team_name}')">RESTORE</button>`
                : `<button class="btn btn-outline-crimson btn-sm" onclick="handleEliminateTeam(${t.id}, '${t.team_name}')">ELIMINATE</button>`}
              <button class="btn btn-danger btn-sm" onclick="handleDeleteTeam(${t.id}, '${t.team_name}')">DEL</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Search filter
  const searchInput = document.getElementById('team-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = cachedTeams.filter(t => 
        t.team_id.toLowerCase().includes(q) || t.team_name.toLowerCase().includes(q)
      );
      renderTeamsTable(filtered);
    });
  }

  // Eliminate Team
  window.handleEliminateTeam = async (id, name) => {
    if (confirm(`⚠️ ELIMINATE TEAM?\n\nTeam: ${name}\n\nThis will remove the team from active participation and deny room entry.`)) {
      const res = await api.eliminateTeam(id);
      if (res.success) {
        window.soundSystem.playDeniedBuzzer();
        loadTeams();
      } else {
        alert(res.message);
      }
    }
  };

  // Restore Team
  window.handleRestoreTeam = async (id, name) => {
    if (confirm(`Restore ${name} to ACTIVE participation?`)) {
      const res = await api.restoreTeam(id);
      if (res.success) {
        window.soundSystem.playSuccessBeep();
        loadTeams();
      }
    }
  };

  // Delete Team
  window.handleDeleteTeam = async (id, name) => {
    if (confirm(`Are you sure you want to permanently delete ${name}?`)) {
      const res = await api.deleteTeam(id);
      if (res.success) loadTeams();
    }
  };

  // 8. Tab: Rounds & Time Limits
  async function loadRounds() {
    const res = await api.getRounds();
    if (!res.success) return;

    const { rounds, rooms, settings } = res;

    // Rounds list container
    const roundsContainer = document.getElementById('rounds-list-container');
    roundsContainer.innerHTML = rounds.map(r => {
      const isActive = r.status === 'ACTIVE';
      const statusBadge = isActive 
        ? '<span class="badge badge-active">ACTIVE ROUND</span>' 
        : (r.status === 'COMPLETED' ? '<span class="badge badge-crimson">COMPLETED</span>' : '<span class="badge badge-warning">PENDING</span>');

      return `
        <div class="card tactical-frame" style="display: flex; justify-content: space-between; align-items: center; padding: 1.25rem;">
          <div>
            <h3 style="font-size: 1.1rem; margin-bottom: 0.2rem;">ROUND ${r.round_number}</h3>
            ${statusBadge}
          </div>
          <div>
            ${!isActive ? `<button class="btn btn-primary btn-sm" onclick="handleActivateRound(${r.id}, ${r.round_number})">START ROUND ${r.round_number}</button>` : '<span class="mono text-muted">Currently Active</span>'}
          </div>
        </div>
      `;
    }).join('');

    // Matrix settings
    const matrixContainer = document.getElementById('room-settings-matrix');
    matrixContainer.innerHTML = rounds.map(r => {
      return `
        <div style="margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border-subtle);">
          <h4 style="margin-bottom: 0.75rem; color: var(--crimson-bright);">ROUND ${r.round_number} SETTINGS</h4>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem;">
            ${rooms.map(room => {
              const currentSetting = settings.find(s => s.round_id === r.id && s.room_id === room.id);
              const duration = currentSetting ? currentSetting.duration_minutes : 5;
              const inputId = `duration-${r.id}-${room.id}`;

              return `
                <div class="card" style="background: var(--bg-surface); padding: 1rem;">
                  <div style="font-size: 0.85rem; font-weight: 700; margin-bottom: 0.5rem;">${room.room_name}</div>
                  <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <input type="number" id="${inputId}" class="form-control" value="${duration}" min="1" max="120" style="max-width: 90px; text-align: center;">
                    <span class="mono text-muted" style="font-size: 0.8rem;">minutes</span>
                    <button class="btn btn-secondary btn-sm" onclick="handleSaveRoomDuration(${r.id}, ${room.id}, '${inputId}')">SAVE</button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  // Activate Round
  window.handleActivateRound = async (roundId, roundNumber) => {
    if (confirm(`START ROUND ${roundNumber}?\n\nThis will make Round ${roundNumber} active and reset room access permissions for all teams for this round.`)) {
      const res = await api.activateRound(roundId);
      if (res.success) {
        window.soundSystem.playSuccessBeep();
        loadRounds();
        loadOverview();
      }
    }
  };

  // Save Duration
  window.handleSaveRoomDuration = async (roundId, roomId, inputId) => {
    const input = document.getElementById(inputId);
    const duration = parseInt(input.value, 10);
    const res = await api.updateRoomDuration(roundId, roomId, duration);
    if (res.success) {
      window.soundSystem.playSuccessBeep();
      alert('Room time limit saved.');
    }
  };

  // Create Round
  const btnCreateRound = document.getElementById('btn-create-round');
  if (btnCreateRound) {
    btnCreateRound.addEventListener('click', async () => {
      const roundNumStr = prompt('Enter next round number (e.g. 4):');
      if (roundNumStr) {
        const res = await api.createRound(roundNumStr);
        if (res.success) {
          loadRounds();
        } else {
          alert(res.message);
        }
      }
    });
  }

  // 9. Tab: Sub Admins (Volunteers)
  async function loadVolunteers() {
    const res = await api.getSubAdmins();
    if (!res.success) return;

    const tbody = document.getElementById('subadmins-tbody');
    if (res.sub_admins.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-dim" style="text-align: center; padding: 2rem;">No volunteer accounts created.</td></tr>`;
      return;
    }

    tbody.innerHTML = res.sub_admins.map(s => {
      return `
        <tr>
          <td><strong class="mono">${s.username}</strong></td>
          <td><strong>${s.name || s.username}</strong></td>
          <td><span class="badge badge-crimson">${s.assigned_room}</span></td>
          <td><span class="mono text-muted">${new Date(s.created_at).toLocaleDateString()}</span></td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="handleDeleteSubAdmin(${s.id}, '${s.username}')">REMOVE</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.handleDeleteSubAdmin = async (id, username) => {
    if (confirm(`Remove volunteer ${username}?`)) {
      await api.deleteSubAdmin(id);
      loadVolunteers();
    }
  };

  // 10. Tab: Logs
  async function loadLogs() {
    const res = await api.getLogs();
    if (!res.success) return;

    const tbody = document.getElementById('logs-tbody');
    tbody.innerHTML = res.logs.map(l => {
      return `
        <tr>
          <td><span class="mono text-muted">${new Date(l.timestamp).toLocaleTimeString()}</span></td>
          <td><span class="mono">${l.username || 'SYSTEM'}</span></td>
          <td><span class="badge badge-secondary">${l.action}</span></td>
          <td style="color: var(--white);">${l.details || ''}</td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('btn-refresh-logs').addEventListener('click', loadLogs);

  // 11. Tab: Danger Zone - Dangerous Event Reset
  const btnTriggerResetModal = document.getElementById('btn-trigger-reset-modal');
  const btnExecuteEventReset = document.getElementById('btn-execute-event-reset');
  const inputConfirmResetCode = document.getElementById('input-confirm-reset-code');

  btnTriggerResetModal.addEventListener('click', () => {
    inputConfirmResetCode.value = '';
    openModal('modal-reset-event');
  });

  btnExecuteEventReset.addEventListener('click', async () => {
    const code = inputConfirmResetCode.value.trim();
    if (code !== 'RESET AURORA') {
      alert('Confirmation failed! You must type exactly: RESET AURORA');
      return;
    }

    const res = await api.resetEvent(code);
    closeModal('modal-reset-event');
    if (res.success) {
      window.soundSystem.playDeniedBuzzer();
      alert(res.message);
      loadOverview();
    } else {
      alert(res.message);
    }
  });

  // Sample Data Purge & Reseed
  document.getElementById('btn-clear-sample-data').addEventListener('click', async () => {
    if (confirm('Purge all sample teams? Do this before registering real competition teams.')) {
      const res = await api.clearSampleData();
      alert(res.message);
      loadOverview();
      loadTeams();
    }
  });

  document.getElementById('btn-reseed-sample-data').addEventListener('click', async () => {
    if (confirm('Reseed 5 sample demo teams for testing?')) {
      const res = await api.reseedSampleData();
      alert(res.message);
      loadOverview();
      loadTeams();
    }
  });

  // 12. Modals Management
  function setupModals() {
    // Open Create Team
    document.getElementById('btn-open-create-team').addEventListener('click', () => {
      document.getElementById('manage-team-id-pk').value = '';
      document.getElementById('manage-team-id').value = '';
      document.getElementById('manage-team-id').removeAttribute('disabled');
      document.getElementById('manage-team-name').value = '';
      document.getElementById('manage-team-score').value = '0';
      document.getElementById('manage-team-password').value = '';
      document.getElementById('modal-team-title').textContent = 'REGISTER NEW TEAM';
      openModal('modal-team');
    });

    // Save Team Form
    document.getElementById('form-team-manage').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pk = document.getElementById('manage-team-id-pk').value;
      const teamId = document.getElementById('manage-team-id').value;
      const teamName = document.getElementById('manage-team-name').value;
      const score = document.getElementById('manage-team-score').value;
      const password = document.getElementById('manage-team-password').value;

      if (pk) {
        // Edit
        const res = await api.updateTeam(pk, { team_name: teamName, score, password });
        if (res.success) {
          closeModal('modal-team');
          loadTeams();
        } else {
          alert(res.message);
        }
      } else {
        // Create
        const res = await api.createTeam({ team_id: teamId, team_name: teamName, score, password });
        if (res.success) {
          closeModal('modal-team');
          loadTeams();
        } else {
          alert(res.message);
        }
      }
    });

    // Open Create Sub Admin
    document.getElementById('btn-open-create-subadmin').addEventListener('click', () => {
      document.getElementById('subadmin-id').value = '';
      document.getElementById('subadmin-name').value = '';
      document.getElementById('subadmin-password').value = '';
      openModal('modal-subadmin');
    });

    document.getElementById('form-subadmin-manage').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('subadmin-id').value;
      const name = document.getElementById('subadmin-name').value;
      const password = document.getElementById('subadmin-password').value;
      const assigned_room = document.getElementById('subadmin-room').value;

      const res = await api.createSubAdmin({ username, name, password, assigned_room });
      if (res.success) {
        closeModal('modal-subadmin');
        loadVolunteers();
      } else {
        alert(res.message);
      }
    });
  }

  // QR Modal
  window.openQrModal = async (teamPk, teamId, teamName) => {
    currentViewingQrTeamId = teamPk;
    const res = await api.getTeamQR(teamPk);
    if (!res.success) return;

    document.getElementById('modal-qr-title').textContent = `QR PASS: ${teamName}`;
    document.getElementById('modal-qr-subtext').textContent = `${teamId} — THE AURORA PROTOCOL`;
    document.getElementById('modal-qr-img').src = res.qr_data_url;
    document.getElementById('modal-qr-token-text').value = res.qr_token;

    // Set download link
    const btnDownload = document.getElementById('btn-download-qr');
    btnDownload.onclick = () => {
      const a = document.createElement('a');
      a.href = res.qr_data_url;
      a.download = `AURORA_${teamId}_QR.png`;
      a.click();
    };

    openModal('modal-qr');
  };

  // Regenerate QR
  document.getElementById('btn-regenerate-qr').addEventListener('click', async () => {
    if (!currentViewingQrTeamId) return;
    if (confirm('Regenerate security token? Any previous physical printed QR code will become invalid.')) {
      const res = await api.regenerateQR(currentViewingQrTeamId);
      if (res.success) {
        window.openQrModal(currentViewingQrTeamId, 'UPDATED', 'UPDATED');
      }
    }
  });

  // Edit Team Modal
  window.openEditTeamModal = (pk) => {
    const t = cachedTeams.find(item => item.id === pk);
    if (!t) return;

    document.getElementById('manage-team-id-pk').value = t.id;
    document.getElementById('manage-team-id').value = t.team_id;
    document.getElementById('manage-team-id').setAttribute('disabled', 'true');
    document.getElementById('manage-team-name').value = t.team_name;
    document.getElementById('manage-team-score').value = t.score;
    document.getElementById('manage-team-password').value = '';
    document.getElementById('modal-team-title').textContent = `EDIT TEAM: ${t.team_id}`;

    openModal('modal-team');
  };

  // Modal helpers
  window.openModal = (id) => {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
  };

  window.closeModal = (id) => {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
  };

  // 13. Socket.IO Live Updates
  socket.on('dashboard_update', () => {
    if (currentUser && currentUser.role === 'HEAD_ADMIN') {
      if (activeTab === 'overview') loadOverview();
      if (activeTab === 'teams') loadTeams();
    }
  });

  socket.on('room_entry_started', () => {
    if (currentUser && currentUser.role === 'HEAD_ADMIN' && activeTab === 'overview') {
      loadOverview();
    }
  });

  // Start initialization
  checkSession();
});
