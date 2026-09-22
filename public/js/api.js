// API Client and Session Manager
const api = {
  serverOffset: 0, // difference between server time and local client time

  setToken(token) {
    if (token) {
      localStorage.setItem('aurora_token', token);
    } else {
      localStorage.removeItem('aurora_token');
    }
  },

  getToken() {
    return localStorage.getItem('aurora_token');
  },

  async request(endpoint, options = {}) {
    const headers = options.headers || {};
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    try {
      const res = await fetch(endpoint, {
        ...options,
        headers,
        credentials: 'same-origin'
      });

      const data = await res.json().catch(() => ({ success: false, message: 'Invalid response from server' }));

      // Sync server time offset if provided
      if (data && data.server_time) {
        this.serverOffset = data.server_time - Date.now();
      }

      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          error_code: data.error_code || 'ERROR',
          message: data.message || `Request failed with code ${res.status}`,
          data
        };
      }

      return data;
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err);
      return {
        success: false,
        error_code: 'NETWORK_ERROR',
        message: 'Could not connect to the server. Check your network connection.'
      };
    }
  },

  // Authoritative server-synced current timestamp
  now() {
    return Date.now() + this.serverOffset;
  },

  // Auth methods
  async adminLogin(username, password) {
    const res = await this.request('/api/auth/admin-login', {
      method: 'POST',
      body: { username, password }
    });
    if (res.success && res.token) {
      this.setToken(res.token);
    }
    return res;
  },

  async studentLogin(team_id, password) {
    const res = await this.request('/api/auth/student-login', {
      method: 'POST',
      body: { team_id, password }
    });
    if (res.success && res.token) {
      this.setToken(res.token);
    }
    return res;
  },

  async getMe() {
    return await this.request('/api/auth/me');
  },

  async logout() {
    await this.request('/api/auth/logout', { method: 'POST' });
    this.setToken(null);
  },

  // Student methods
  async getStudentDashboard() {
    return await this.request('/api/student/dashboard');
  },

  async getLeaderboard() {
    return await this.request('/api/student/leaderboard');
  },

  // Scanner methods
  async getMyRoom(roomCode) {
    const query = roomCode ? `?room_code=${encodeURIComponent(roomCode)}` : '';
    return await this.request(`/api/scanner/my-room${query}`);
  },

  async validateScan(qr_token, room_code) {
    return await this.request('/api/scanner/validate-scan', {
      method: 'POST',
      body: { qr_token, room_code }
    });
  },

  async completeEntry(entry_id) {
    return await this.request('/api/scanner/complete-entry', {
      method: 'POST',
      body: { entry_id }
    });
  },

  // Admin methods
  async getAdminOverview() {
    return await this.request('/api/admin/overview');
  },

  async getAdminTeams() {
    return await this.request('/api/admin/teams');
  },

  async createTeam(teamData) {
    return await this.request('/api/admin/teams', {
      method: 'POST',
      body: teamData
    });
  },

  async updateTeam(id, teamData) {
    return await this.request(`/api/admin/teams/${id}`, {
      method: 'PUT',
      body: teamData
    });
  },

  async updateScore(teamId, newScore) {
    return await this.request(`/api/admin/teams/${teamId}/score`, {
      method: 'POST',
      body: { new_score: newScore }
    });
  },

  async eliminateTeam(teamId) {
    return await this.request(`/api/admin/teams/${teamId}/eliminate`, {
      method: 'POST'
    });
  },

  async restoreTeam(teamId) {
    return await this.request(`/api/admin/teams/${teamId}/restore`, {
      method: 'POST'
    });
  },

  async deleteTeam(teamId) {
    return await this.request(`/api/admin/teams/${teamId}`, {
      method: 'DELETE'
    });
  },

  async getTeamQR(teamId) {
    return await this.request(`/api/admin/teams/${teamId}/qr`);
  },

  async regenerateQR(teamId) {
    return await this.request(`/api/admin/teams/${teamId}/regenerate-qr`, {
      method: 'POST'
    });
  },

  async getRounds() {
    return await this.request('/api/admin/rounds');
  },

  async createRound(round_number) {
    return await this.request('/api/admin/rounds', {
      method: 'POST',
      body: { round_number }
    });
  },

  async activateRound(roundId) {
    return await this.request(`/api/admin/rounds/${roundId}/activate`, {
      method: 'POST'
    });
  },

  async updateRoomDuration(round_id, room_id, duration_minutes) {
    return await this.request('/api/admin/room-settings', {
      method: 'POST',
      body: { round_id, room_id, duration_minutes }
    });
  },

  async getSubAdmins() {
    return await this.request('/api/admin/sub-admins');
  },

  async createSubAdmin(data) {
    return await this.request('/api/admin/sub-admins', {
      method: 'POST',
      body: data
    });
  },

  async deleteSubAdmin(id) {
    return await this.request(`/api/admin/sub-admins/${id}`, {
      method: 'DELETE'
    });
  },

  async getLogs() {
    return await this.request('/api/admin/logs');
  },

  async resetEvent(confirmationCode) {
    return await this.request('/api/admin/reset-event', {
      method: 'POST',
      body: { confirmation_code: confirmationCode }
    });
  },

  async clearSampleData() {
    return await this.request('/api/admin/clear-sample-data', {
      method: 'POST'
    });
  },

  async reseedSampleData() {
    return await this.request('/api/admin/reseed-sample-data', {
      method: 'POST'
    });
  }
};

window.api = api;
