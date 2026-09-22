// Student Portal Client Logic
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Elements
  const splashScreen = document.getElementById('splash-screen');
  const splashProgressBar = document.getElementById('splash-progress-bar');
  const splashStatusText = document.getElementById('splash-status-text');
  const appNav = document.getElementById('app-nav');
  const loginView = document.getElementById('student-login-view');
  const dashboardView = document.getElementById('student-dashboard-view');
  const loginForm = document.getElementById('student-login-form');
  const loginAlert = document.getElementById('login-alert');
  const btnLogout = document.getElementById('btn-logout');
  const btnSoundToggle = document.getElementById('btn-sound-toggle');

  // Dashboard elements
  const displayTeamName = document.getElementById('display-team-name');
  const badgeTeamId = document.getElementById('badge-team-id');
  const badgeCurrentRound = document.getElementById('badge-current-round');
  const badgeTeamStatus = document.getElementById('badge-team-status');
  const displayTeamScore = document.getElementById('display-team-score');
  const eliminatedNotice = document.getElementById('eliminated-notice');
  const activeRoomCountdown = document.getElementById('active-room-countdown');
  const countdownRoomName = document.getElementById('countdown-room-name');
  const countdownTimerDisplay = document.getElementById('countdown-timer-display');
  const statusRoomPolice = document.getElementById('status-room-police');
  const statusRoomLab = document.getElementById('status-room-lab');
  const leaderboardList = document.getElementById('leaderboard-list');

  let currentTeam = null;
  let activeCountdownInterval = null;
  let cachedLeaderboardScores = {};

  // 1. Audio Toggle
  btnSoundToggle.addEventListener('click', () => {
    window.soundSystem.muted = !window.soundSystem.muted;
    btnSoundToggle.textContent = window.soundSystem.muted ? '🔇 AUDIO OFF' : '🔊 AUDIO ON';
    btnSoundToggle.classList.toggle('btn-secondary', !window.soundSystem.muted);
    btnSoundToggle.classList.toggle('btn-outline-crimson', window.soundSystem.muted);
  });

  // 2. INTELLIX Splash Screen Animation (2.5 seconds duration)
  function runSplashScreen() {
    let progress = 0;
    const duration = 2400; // ms
    const intervalTime = 30;
    const step = 100 / (duration / intervalTime);

    const timer = setInterval(() => {
      progress += step;
      if (progress >= 100) {
        progress = 100;
        clearInterval(timer);
        splashProgressBar.style.width = '100%';
        splashStatusText.textContent = 'PROTOCOL LINK ESTABLISHED. 100%';

        setTimeout(() => {
          splashScreen.style.opacity = '0';
          setTimeout(() => {
            splashScreen.style.display = 'none';
            appNav.style.display = 'block';
            checkSession();
          }, 600);
        }, 300);
      } else {
        splashProgressBar.style.width = `${progress}%`;
        splashStatusText.textContent = `INITIALIZING DIGITAL CASE FILES... ${Math.floor(progress)}%`;
      }
    }, intervalTime);
  }

  // 3. Check Existing Session
  async function checkSession() {
    const res = await api.getMe();
    if (res.success && res.user && res.user.role === 'STUDENT') {
      currentTeam = res.user;
      showDashboard();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginView.style.display = 'flex';
    dashboardView.style.display = 'none';
    btnLogout.style.display = 'none';
  }

  async function showDashboard() {
    loginView.style.display = 'none';
    dashboardView.style.display = 'block';
    btnLogout.style.display = 'inline-flex';

    await refreshDashboard();
    await refreshLeaderboard();
  }

  // 4. Student Login Handling
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginAlert.style.display = 'none';

    const teamId = document.getElementById('login-team-id').value;
    const password = document.getElementById('login-password').value;

    const res = await api.studentLogin(teamId, password);
    if (!res.success) {
      loginAlert.textContent = res.message || 'Login failed. Please check Team ID and Password.';
      loginAlert.style.display = 'block';
      window.soundSystem.playDeniedBuzzer();
      return;
    }

    window.soundSystem.playSuccessBeep();
    currentTeam = res.team;
    showDashboard();
  });

  // 5. Logout
  btnLogout.addEventListener('click', async () => {
    await api.logout();
    currentTeam = null;
    if (activeCountdownInterval) clearInterval(activeCountdownInterval);
    showLogin();
  });

  // 6. Refresh Student Dashboard Data
  async function refreshDashboard() {
    const res = await api.getStudentDashboard();
    if (!res.success) {
      if (res.status === 401 || res.status === 403) {
        showLogin();
      }
      return;
    }

    const { team, current_round, active_entry, completed_rooms } = res;
    currentTeam = team;

    // Update Header
    displayTeamName.textContent = team.team_name;
    badgeTeamId.textContent = team.team_id;
    badgeCurrentRound.textContent = `ROUND ${current_round ? current_round.round_number : 1}`;
    displayTeamScore.textContent = team.score;

    // Status & Elimination
    if (team.status === 'ELIMINATED') {
      badgeTeamStatus.textContent = 'ELIMINATED';
      badgeTeamStatus.className = 'badge badge-eliminated';
      eliminatedNotice.style.display = 'block';
    } else {
      badgeTeamStatus.textContent = 'ACTIVE';
      badgeTeamStatus.className = 'badge badge-active';
      eliminatedNotice.style.display = 'none';
    }

    // Room Clearance Checklist
    let policeCompleted = false;
    let labCompleted = false;
    if (completed_rooms && Array.isArray(completed_rooms)) {
      policeCompleted = completed_rooms.some(r => r.room_code === 'POLICE');
      labCompleted = completed_rooms.some(r => r.room_code === 'LAB');
    }

    statusRoomPolice.textContent = policeCompleted ? 'CLEARED' : 'NOT ENTERED';
    statusRoomPolice.className = `badge ${policeCompleted ? 'badge-active' : 'badge-warning'}`;

    statusRoomLab.textContent = labCompleted ? 'CLEARED' : 'NOT ENTERED';
    statusRoomLab.className = `badge ${labCompleted ? 'badge-active' : 'badge-warning'}`;

    // Active Room Countdown
    if (active_entry && active_entry.expiry_time > api.now()) {
      startCountdown(active_entry);
    } else {
      stopCountdown();
    }
  }

  // 7. Active Room Countdown Management (Server Authoritative)
  function startCountdown(entry) {
    if (activeCountdownInterval) clearInterval(activeCountdownInterval);

    countdownRoomName.textContent = entry.room_name;
    activeRoomCountdown.style.display = 'block';

    function update() {
      const remainingSeconds = Math.max(0, Math.floor((entry.expiry_time - api.now()) / 1000));
      const mins = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
      const secs = String(remainingSeconds % 60).padStart(2, '0');
      countdownTimerDisplay.textContent = `${mins}:${secs}`;

      if (remainingSeconds <= 60 && remainingSeconds > 0) {
        activeRoomCountdown.classList.add('urgent');
      } else {
        activeRoomCountdown.classList.remove('urgent');
      }

      if (remainingSeconds <= 0) {
        clearInterval(activeCountdownInterval);
        countdownTimerDisplay.textContent = '00:00';
        activeRoomCountdown.classList.remove('urgent');
        refreshDashboard();
      }
    }

    update();
    activeCountdownInterval = setInterval(update, 1000);
  }

  function stopCountdown() {
    if (activeCountdownInterval) clearInterval(activeCountdownInterval);
    activeRoomCountdown.style.display = 'none';
  }

  // 8. Live Animated Leaderboard (FLIP Animation)
  async function refreshLeaderboard(newTeamsData) {
    let teams = newTeamsData;
    if (!teams) {
      const res = await api.getLeaderboard();
      if (!res.success) return;
      teams = res.teams;
    }

    // Capture initial positions for FLIP animation
    const oldPositions = {};
    const existingRows = leaderboardList.querySelectorAll('.leaderboard-row');
    existingRows.forEach(row => {
      const id = row.getAttribute('data-team-id');
      oldPositions[id] = row.getBoundingClientRect().top;
    });

    // Render / update leaderboard items
    leaderboardList.innerHTML = '';
    teams.forEach((t, index) => {
      const rank = index + 1;
      const row = document.createElement('div');
      row.className = `leaderboard-row rank-${rank}`;
      row.setAttribute('data-team-id', t.id);

      if (currentTeam && t.id === currentTeam.id) {
        row.classList.add('current-team');
      }

      // Check if score changed
      if (cachedLeaderboardScores[t.id] !== undefined && cachedLeaderboardScores[t.id] !== t.score) {
        row.classList.add('highlight-update');
      }
      cachedLeaderboardScores[t.id] = t.score;

      const isEliminated = t.status === 'ELIMINATED';

      row.innerHTML = `
        <div style="display: flex; align-items: center; flex: 1;">
          <div class="rank-badge">${rank}</div>
          <div class="leaderboard-team-info">
            <div>
              <div class="leaderboard-team-name">
                ${t.team_name}
                ${isEliminated ? '<span class="badge badge-eliminated" style="margin-left: 0.5rem;">ELIMINATED</span>' : ''}
              </div>
              <div class="mono text-dim" style="font-size: 0.75rem;">${t.team_id}</div>
            </div>
          </div>
        </div>
        <div class="leaderboard-score-wrapper">
          <div class="leaderboard-score">${t.score}</div>
          <div class="leaderboard-score-label">PTS</div>
        </div>
      `;

      leaderboardList.appendChild(row);
    });

    // FLIP Animation: animate transition from old to new positions
    requestAnimationFrame(() => {
      const newRows = leaderboardList.querySelectorAll('.leaderboard-row');
      newRows.forEach(row => {
        const id = row.getAttribute('data-team-id');
        const oldTop = oldPositions[id];
        if (oldTop !== undefined) {
          const newTop = row.getBoundingClientRect().top;
          const deltaY = oldTop - newTop;
          if (deltaY !== 0) {
            row.style.transform = `translateY(${deltaY}px)`;
            row.style.transition = 'none';

            requestAnimationFrame(() => {
              row.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
              row.style.transform = '';
            });
          }
        }
      });
    });
  }

  // 9. Socket.IO Real-Time Event Handlers
  socket.on('leaderboard_update', (teams) => {
    refreshLeaderboard(teams);
  });

  socket.on('score_updated', (data) => {
    if (currentTeam && currentTeam.team_id === data.team_id) {
      currentTeam.score = data.new_score;
      displayTeamScore.textContent = data.new_score;
    }
  });

  socket.on('team_status_update', (data) => {
    if (currentTeam && currentTeam.team_id === data.team_id) {
      currentTeam.status = data.status;
      refreshDashboard();
      if (data.status === 'ELIMINATED') {
        window.soundSystem.playDeniedBuzzer();
      }
    }
  });

  socket.on('room_entry_started', (data) => {
    if (currentTeam && currentTeam.id === data.team.id) {
      window.soundSystem.playSuccessBeep();
      refreshDashboard();
    }
  });

  socket.on('round_changed', () => {
    refreshDashboard();
  });

  socket.on('event_reset', () => {
    refreshDashboard();
    refreshLeaderboard();
  });

  // Start Splash Sequence
  runSplashScreen();
});
