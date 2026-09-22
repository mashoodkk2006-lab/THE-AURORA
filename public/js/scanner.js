// Sub Admin / Room Volunteer QR Scanner Controller
class RoomScanner {
  constructor() {
    this.html5QrCode = null;
    this.isScanning = false;
    this.currentRoomCode = 'POLICE';
    this.currentRoomName = 'POLICE INVESTIGATION ROOM';
    this.activeEntry = null;
    this.countdownTimer = null;
  }

  async init(userRoomCode) {
    if (userRoomCode) {
      this.currentRoomCode = userRoomCode;
    }

    this.bindEvents();
    await this.refreshRoomState();
  }

  bindEvents() {
    const btnToggleCamera = document.getElementById('btn-toggle-camera');
    const manualForm = document.getElementById('scanner-manual-form');
    const btnDismissTimesUp = document.getElementById('btn-dismiss-times-up');
    const btnEarlyComplete = document.getElementById('btn-scanner-early-complete');

    if (btnToggleCamera) {
      btnToggleCamera.addEventListener('click', () => this.toggleCamera());
    }

    if (manualForm) {
      manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('scanner-manual-input');
        if (input.value.trim()) {
          this.processScan(input.value.trim());
          input.value = '';
        }
      });
    }

    if (btnDismissTimesUp) {
      btnDismissTimesUp.addEventListener('click', () => this.dismissTimesUp());
    }

    if (btnEarlyComplete) {
      btnEarlyComplete.addEventListener('click', () => this.completeCurrentRoom());
    }
  }

  async refreshRoomState() {
    const res = await api.getMyRoom(this.currentRoomCode);
    if (!res.success) return;

    this.currentRoomName = res.room.room_name;
    document.getElementById('scanner-room-name-display').textContent = res.room.room_name;
    document.getElementById('scanner-round-display').textContent = `ROUND ${res.current_round ? res.current_round.round_number : 1}`;

    // Render recent visitors
    this.renderRecentVisits(res.visited_teams || []);

    // Check if team currently inside
    if (res.active_entry && res.active_entry.expiry_time > api.now()) {
      this.activeEntry = res.active_entry;
      this.startTimer(res.active_entry);
    } else {
      this.stopTimer();
    }
  }

  renderRecentVisits(visits) {
    const tbody = document.getElementById('scanner-recent-tbody');
    if (!tbody) return;

    if (visits.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-dim" style="text-align: center; padding: 1.5rem;">No teams have entered this room yet in this round.</td></tr>`;
      return;
    }

    tbody.innerHTML = visits.map(v => {
      const timeStr = new Date(v.entry_time).toLocaleTimeString();
      const statusBadge = v.status === 'ACTIVE' 
        ? '<span class="badge badge-active">INSIDE ROOM</span>' 
        : '<span class="badge badge-crimson">COMPLETED</span>';
      return `
        <tr>
          <td><span class="mono">${v.team_id}</span></td>
          <td><strong>${v.team_name}</strong></td>
          <td><span class="mono text-muted">${timeStr}</span></td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');
  }

  async toggleCamera() {
    const btn = document.getElementById('btn-toggle-camera');
    const readerElement = document.getElementById('reader');

    if (this.isScanning) {
      if (this.html5QrCode) {
        await this.html5QrCode.stop().catch(console.error);
        this.html5QrCode.clear();
      }
      this.isScanning = false;
      btn.textContent = 'START CAMERA';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
      return;
    }

    try {
      this.html5QrCode = new Html5Qrcode("reader");
      const config = { fps: 10, qrbox: { width: 220, height: 220 } };

      await this.html5QrCode.start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
          window.soundSystem.playScanBlip();
          this.processScan(decodedText);
        },
        (errorMessage) => {
          // Frame scan error - ignore to prevent spam
        }
      );

      this.isScanning = true;
      btn.textContent = 'STOP CAMERA';
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
    } catch (err) {
      console.warn('Camera start error:', err);
      alert('Camera access failed or was denied. You can use the manual Team ID input below.');
    }
  }

  async processScan(rawScanValue) {
    const resultBox = document.getElementById('scanner-result-feedback');
    resultBox.style.display = 'none';

    const res = await api.validateScan(rawScanValue, this.currentRoomCode);

    resultBox.style.display = 'block';

    if (res.success) {
      // 🟢 ACCESS GRANTED
      window.soundSystem.playSuccessBeep();

      resultBox.innerHTML = `
        <div class="scan-result-card granted tactical-frame">
          <div class="scan-result-title">🟢 ACCESS GRANTED</div>
          <div class="scan-result-details">
            <div style="font-size: 1.3rem; font-weight: 800; color: #fff; margin-bottom: 0.3rem;">${res.team.team_name} (${res.team.team_id})</div>
            <div class="text-muted">ROOM: <strong>${res.room.room_name}</strong> | ROUND ${res.round.round_number}</div>
            <div class="text-muted">TIME LIMIT: <strong>${res.duration_minutes} MINUTES</strong></div>
          </div>
          <div class="badge badge-active" style="font-size: 0.85rem; padding: 0.4rem 1rem;">
            COUNTDOWN INITIATED — INVESTIGATION CAN COMMENCE
          </div>
        </div>
      `;

      this.activeEntry = {
        id: res.entry_id,
        team_id: res.team.team_id,
        team_name: res.team.team_name,
        entry_time: res.entry_time,
        expiry_time: res.expiry_time
      };

      this.startTimer(this.activeEntry);
      this.refreshRoomState();
    } else {
      // 🔴 ACCESS DENIED
      window.soundSystem.playDeniedBuzzer();

      resultBox.innerHTML = `
        <div class="scan-result-card denied tactical-frame">
          <div class="scan-result-title">🚫 ACCESS DENIED</div>
          <div class="scan-result-details" style="color: #fca5a5;">
            ${res.message || 'Team entry validation failed.'}
          </div>
          <div class="badge badge-eliminated" style="font-size: 0.85rem; padding: 0.4rem 1rem;">
            ENTRY REFUSED BY SECURITY PROTOCOL
          </div>
        </div>
      `;
    }
  }

  startTimer(entry) {
    if (this.countdownTimer) clearInterval(this.countdownTimer);

    const timerBox = document.getElementById('scanner-active-timer-box');
    const teamNameDisplay = document.getElementById('scanner-active-team-name');
    const digitsDisplay = document.getElementById('scanner-countdown-digits');

    timerBox.style.display = 'block';
    teamNameDisplay.textContent = `${entry.team_name} (${entry.team_id})`;

    const tick = () => {
      const remainingSeconds = Math.max(0, Math.floor((entry.expiry_time - api.now()) / 1000));
      const mins = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
      const secs = String(remainingSeconds % 60).padStart(2, '0');
      digitsDisplay.textContent = `${mins}:${secs}`;

      if (remainingSeconds <= 60 && remainingSeconds > 0) {
        timerBox.classList.add('urgent');
      } else {
        timerBox.classList.remove('urgent');
      }

      if (remainingSeconds <= 0) {
        clearInterval(this.countdownTimer);
        timerBox.classList.remove('urgent');
        digitsDisplay.textContent = '00:00';
        this.triggerTimesUp(entry);
      }
    };

    tick();
    this.countdownTimer = setInterval(tick, 1000);
  }

  stopTimer() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    document.getElementById('scanner-active-timer-box').style.display = 'none';
    this.activeEntry = null;
  }

  triggerTimesUp(entry) {
    window.soundSystem.playTimeUpAlarm();

    const modal = document.getElementById('times-up-modal');
    document.getElementById('times-up-team-name').textContent = entry.team_name;
    document.getElementById('times-up-room-name').textContent = this.currentRoomName;

    modal.style.display = 'flex';
  }

  async dismissTimesUp() {
    document.getElementById('times-up-modal').style.display = 'none';
    if (this.activeEntry) {
      await api.completeEntry(this.activeEntry.id);
    }
    this.stopTimer();
    this.refreshRoomState();

    // Auto focus manual input for next team
    const manualInput = document.getElementById('scanner-manual-input');
    if (manualInput) manualInput.focus();
  }

  async completeCurrentRoom() {
    if (!this.activeEntry) return;
    if (confirm(`Mark investigation completed early for ${this.activeEntry.team_name}?`)) {
      await api.completeEntry(this.activeEntry.id);
      this.stopTimer();
      this.refreshRoomState();
    }
  }
}

window.scanner = new RoomScanner();
