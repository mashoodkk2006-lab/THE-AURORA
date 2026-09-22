const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

// Ensure data/ directory exists (important for Railway and fresh deployments)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('Created data/ directory for database storage.');
}

const config = require('./config');
const db = require('./database');
const {
  signToken,
  authMiddleware,
  requireHeadAdmin,
  requireSubAdmin,
  requireStudent
} = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io connection handling
io.on('connection', (socket) => {
  // Join specific rooms if requested
  socket.on('join_room_channel', (roomCode) => {
    socket.join(`room_${roomCode}`);
  });

  socket.on('join_team_channel', (teamId) => {
    socket.join(`team_${teamId}`);
  });
});

// Broadcast helpers
function broadcastLeaderboard() {
  db.all('SELECT id, team_id, team_name, score, status FROM teams ORDER BY score DESC, id ASC')
    .then((teams) => {
      io.emit('leaderboard_update', teams);
    })
    .catch((err) => console.error('Error broadcasting leaderboard:', err));
}

function broadcastEvent(eventName, payload) {
  io.emit(eventName, payload);
}

// -------------------------------------------------------------
// AUTHENTICATION ROUTES
// -------------------------------------------------------------

// Admin Login (Head Admin and Sub Admins)
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Please provide ID and Password.' });
    }

    const user = await db.get('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid Admin Credentials.' });
    }

    const match = await bcrypt.compare(password.trim(), user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid Admin Credentials.' });
    }

    const token = signToken({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      assigned_room: user.assigned_room
    });

    res.cookie('aurora_token', token, {
      httpOnly: true,
      maxAge: 12 * 60 * 60 * 1000,
      sameSite: 'lax'
    });

    await db.logActivity(user.id, user.username, 'ADMIN_LOGIN', `Role: ${user.role}`);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        assigned_room: user.assigned_room
      }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
});

// Student Login (Team ID + Team Name)
app.post('/api/auth/student-login', async (req, res) => {
  try {
    const { team_id, password } = req.body;
    if (!team_id || !password) {
      return res.status(400).json({ success: false, message: 'Team ID and Password are required.' });
    }

    const cleanId = team_id.trim().toUpperCase();
    const cleanPassword = password.trim();

    const team = await db.get('SELECT * FROM teams WHERE UPPER(team_id) = ?', [cleanId]);
    if (!team) {
      return res.status(401).json({ success: false, message: 'Invalid Team ID or Password.' });
    }

    const match = await bcrypt.compare(cleanPassword, team.password_hash);
    // Also allow direct match with team_name as fallback
    const directMatch = cleanPassword.toUpperCase() === team.team_name.toUpperCase();
    if (!match && !directMatch) {
      return res.status(401).json({ success: false, message: 'Invalid Team ID or Password.' });
    }

    const token = signToken({
      id: team.id,
      team_id: team.team_id,
      team_name: team.team_name,
      role: 'STUDENT'
    });

    res.cookie('aurora_token', token, {
      httpOnly: true,
      maxAge: 12 * 60 * 60 * 1000,
      sameSite: 'lax'
    });

    await db.logActivity(null, team.team_id, 'STUDENT_LOGIN', `Team: ${team.team_name}`);

    res.json({
      success: true,
      token,
      team: {
        id: team.id,
        team_id: team.team_id,
        team_name: team.team_name,
        score: team.score,
        status: team.status
      }
    });
  } catch (err) {
    console.error('Student login error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
});

// Current User Session
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'STUDENT') {
      const team = await db.get('SELECT id, team_id, team_name, score, status, current_round FROM teams WHERE id = ?', [req.user.id]);
      if (!team) return res.status(404).json({ success: false, message: 'Team not found' });
      return res.json({ success: true, user: { ...req.user, ...team } });
    } else {
      const user = await db.get('SELECT id, username, name, role, assigned_room FROM users WHERE id = ?', [req.user.id]);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      return res.json({ success: true, user });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to retrieve session' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('aurora_token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// -------------------------------------------------------------
// STUDENT PORTAL ROUTES
// -------------------------------------------------------------

// Student Dashboard state
app.get('/api/student/dashboard', authMiddleware, requireStudent, async (req, res) => {
  try {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.user.id]);
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
    }

    const currentRound = await db.get('SELECT * FROM rounds WHERE status = ? LIMIT 1', ['ACTIVE']) || { round_number: 1, status: 'ACTIVE' };

    // Check if team is currently inside any room with active timer
    const now = Date.now();
    const activeEntry = await db.get(`
      SELECT re.*, r.room_name, r.room_code 
      FROM room_entries re
      JOIN rooms r ON re.room_id = r.id
      WHERE re.team_id = ? AND re.status = 'ACTIVE' AND re.expiry_time > ?
      ORDER BY re.entry_time DESC LIMIT 1
    `, [team.id, now]);

    // Check completed rooms for this round
    const completedRooms = await db.all(`
      SELECT r.room_code, r.room_name, re.status
      FROM room_entries re
      JOIN rooms r ON re.room_id = r.id
      WHERE re.team_id = ? AND re.round_id = ?
    `, [team.id, currentRound.id || 1]);

    res.json({
      success: true,
      server_time: now,
      team: {
        id: team.id,
        team_id: team.team_id,
        team_name: team.team_name,
        score: team.score,
        status: team.status
      },
      current_round: currentRound,
      active_entry: activeEntry ? {
        id: activeEntry.id,
        room_name: activeEntry.room_name,
        room_code: activeEntry.room_code,
        entry_time: activeEntry.entry_time,
        expiry_time: activeEntry.expiry_time,
        remaining_seconds: Math.max(0, Math.floor((activeEntry.expiry_time - now) / 1000))
      } : null,
      completed_rooms: completedRooms
    });
  } catch (err) {
    console.error('Student dashboard error:', err);
    res.status(500).json({ success: false, message: 'Error retrieving student dashboard.' });
  }
});

// Live Leaderboard (public / student accessible)
app.get('/api/student/leaderboard', async (req, res) => {
  try {
    const teams = await db.all('SELECT id, team_id, team_name, score, status FROM teams ORDER BY score DESC, id ASC');
    res.json({ success: true, teams, server_time: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to retrieve leaderboard.' });
  }
});

// -------------------------------------------------------------
// SUB ADMIN / ROOM VOLUNTEER SCANNER ROUTES
// -------------------------------------------------------------

// Get scanner room status and active team inside room
app.get('/api/scanner/my-room', authMiddleware, requireSubAdmin, async (req, res) => {
  try {
    const roomCode = req.query.room_code || req.user.assigned_room || 'POLICE';
    const room = await db.get('SELECT * FROM rooms WHERE room_code = ?', [roomCode]);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found.' });
    }

    const currentRound = await db.get('SELECT * FROM rounds WHERE status = ? LIMIT 1', ['ACTIVE']);

    const now = Date.now();
    // Look for currently active team inside this room
    const activeEntry = await db.get(`
      SELECT re.*, t.team_id, t.team_name, t.status as team_status
      FROM room_entries re
      JOIN teams t ON re.team_id = t.id
      WHERE re.room_id = ? AND re.status = 'ACTIVE' AND re.expiry_time > ?
      ORDER BY re.entry_time DESC LIMIT 1
    `, [room.id, now]);

    // Recent teams entered this room during this round
    const roundId = currentRound ? currentRound.id : 0;
    const visitedTeams = await db.all(`
      SELECT re.*, t.team_id, t.team_name
      FROM room_entries re
      JOIN teams t ON re.team_id = t.id
      WHERE re.room_id = ? AND re.round_id = ?
      ORDER BY re.entry_time DESC
    `, [room.id, roundId]);

    res.json({
      success: true,
      room,
      current_round: currentRound,
      server_time: now,
      active_entry: activeEntry ? {
        id: activeEntry.id,
        team_id: activeEntry.team_id,
        team_name: activeEntry.team_name,
        entry_time: activeEntry.entry_time,
        expiry_time: activeEntry.expiry_time,
        remaining_seconds: Math.max(0, Math.floor((activeEntry.expiry_time - now) / 1000))
      } : null,
      visited_teams: visitedTeams
    });
  } catch (err) {
    console.error('Scanner room state error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve room status.' });
  }
});

// Authoritative QR Validation & Access Grant
app.post('/api/scanner/validate-scan', authMiddleware, requireSubAdmin, async (req, res) => {
  try {
    const { qr_token, room_code } = req.body;
    if (!qr_token) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_QR',
        message: 'INVALID QR CODE: Team identifier or token missing.'
      });
    }

    // 1. Is the team valid?
    // Check by qr_token or team_id directly for manual entry convenience
    const rawInput = qr_token.trim();
    let team = await db.get('SELECT * FROM teams WHERE qr_token = ?', [rawInput]);
    if (!team) {
      team = await db.get('SELECT * FROM teams WHERE UPPER(team_id) = ?', [rawInput.toUpperCase()]);
    }
    if (!team) {
      await db.logActivity(req.user.id, req.user.username, 'QR_SCAN_INVALID', `Token: ${rawInput}`);
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_QR',
        message: '❌ INVALID QR CODE: Team could not be identified.'
      });
    }

    // 2. Is the team eliminated?
    if (team.status === 'ELIMINATED') {
      await db.logActivity(req.user.id, req.user.username, 'ACCESS_DENIED_ELIMINATED', `Team: ${team.team_name}`);
      return res.status(400).json({
        success: false,
        error_code: 'TEAM_ELIMINATED',
        team: { team_id: team.team_id, team_name: team.team_name },
        message: '🚫 TEAM ELIMINATED: This team is no longer eligible to participate.'
      });
    }

    const targetRoomCode = (room_code || req.user.assigned_room || 'POLICE').toUpperCase();
    const room = await db.get('SELECT * FROM rooms WHERE room_code = ?', [targetRoomCode]);
    if (!room) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_ROOM',
        message: 'INVALID ROOM ACCESS: Target room does not exist.'
      });
    }

    // If sub-admin is assigned to a specific room, verify permission
    if (req.user.role === 'SUB_ADMIN' && req.user.assigned_room && req.user.assigned_room !== targetRoomCode) {
      return res.status(403).json({
        success: false,
        error_code: 'WRONG_ROOM_PERMISSION',
        message: `RESTRICTED ACCESS: You are assigned to ${req.user.assigned_room}, not ${targetRoomCode}.`
      });
    }

    // 3. Is current round active?
    const currentRound = await db.get('SELECT * FROM rounds WHERE status = ? LIMIT 1', ['ACTIVE']);
    if (!currentRound) {
      return res.status(400).json({
        success: false,
        error_code: 'NO_ACTIVE_ROUND',
        message: '⚠️ NO ACTIVE ROUND: Please wait for the Head Admin to start the next round.'
      });
    }

    // 4. Has the team already entered this room during this round?
    // (Strict rule: TEAM + ROUND + ROOM)
    const existingEntry = await db.get(
      'SELECT * FROM room_entries WHERE team_id = ? AND round_id = ? AND room_id = ?',
      [team.id, currentRound.id, room.id]
    );

    if (existingEntry) {
      await db.logActivity(
        req.user.id,
        req.user.username,
        'ACCESS_DENIED_DUPLICATE',
        `Team: ${team.team_name} tried entering ${room.room_name} again in Round ${currentRound.round_number}`
      );
      return res.status(400).json({
        success: false,
        error_code: 'ALREADY_ENTERED',
        team: { team_id: team.team_id, team_name: team.team_name },
        room: { room_name: room.room_name, room_code: room.room_code },
        round: currentRound.round_number,
        message: `🚫 ACCESS DENIED: ${team.team_name} has already entered ${room.room_name} during ROUND ${currentRound.round_number}.`
      });
    }

    // 5. Check duration setting for this round and room
    const setting = await db.get(
      'SELECT duration_minutes FROM room_settings WHERE round_id = ? AND room_id = ?',
      [currentRound.id, room.id]
    );
    const durationMinutes = setting ? setting.duration_minutes : 5;

    // Start server-authoritative timer
    const now = Date.now();
    const expiryTime = now + durationMinutes * 60 * 1000;

    // Insert new room entry
    const insertResult = await db.run(`
      INSERT INTO room_entries (team_id, round_id, room_id, sub_admin_id, entry_time, expiry_time, status)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
    `, [team.id, currentRound.id, room.id, req.user.id, now, expiryTime]);

    const entryId = insertResult.id;

    await db.logActivity(
      req.user.id,
      req.user.username,
      'ACCESS_GRANTED',
      `Team ${team.team_name} entered ${room.room_name} for ${durationMinutes} mins (Round ${currentRound.round_number})`
    );

    const payload = {
      entry_id: entryId,
      team: {
        id: team.id,
        team_id: team.team_id,
        team_name: team.team_name,
        score: team.score
      },
      room: {
        id: room.id,
        room_code: room.room_code,
        room_name: room.room_name
      },
      round: {
        id: currentRound.id,
        round_number: currentRound.round_number
      },
      duration_minutes: durationMinutes,
      entry_time: now,
      expiry_time: expiryTime,
      server_time: now
    };

    // Emit live real-time events to all connected clients
    broadcastEvent('room_entry_started', payload);
    broadcastEvent('dashboard_update', { type: 'ENTRY_CREATED' });

    res.json({
      success: true,
      ...payload
    });
  } catch (err) {
    console.error('Scan validation error:', err);
    res.status(500).json({ success: false, message: 'Server error processing room scan.' });
  }
});

// Mark Room Entry Completed / Time Expired
app.post('/api/scanner/complete-entry', authMiddleware, requireSubAdmin, async (req, res) => {
  try {
    const { entry_id } = req.body;
    if (!entry_id) {
      return res.status(400).json({ success: false, message: 'Entry ID required.' });
    }

    const entry = await db.get(`
      SELECT re.*, t.team_name, r.room_name, r.room_code
      FROM room_entries re
      JOIN teams t ON re.team_id = t.id
      JOIN rooms r ON re.room_id = r.id
      WHERE re.id = ?
    `, [entry_id]);

    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found.' });
    }

    await db.run("UPDATE room_entries SET status = 'COMPLETED' WHERE id = ?", [entry_id]);

    await db.logActivity(
      req.user.id,
      req.user.username,
      'ROOM_COMPLETED',
      `Team ${entry.team_name} completed visit to ${entry.room_name}`
    );

    broadcastEvent('room_entry_completed', {
      entry_id,
      room_code: entry.room_code,
      team_name: entry.team_name
    });
    broadcastEvent('dashboard_update', { type: 'ENTRY_COMPLETED' });

    res.json({ success: true, message: 'Room visit marked completed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to complete entry.' });
  }
});

// -------------------------------------------------------------
// HEAD ADMIN COMMAND CENTER & MANAGEMENT ROUTES
// -------------------------------------------------------------

// Command center statistics & active state
app.get('/api/admin/overview', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const totalTeams = (await db.get('SELECT COUNT(*) as count FROM teams')).count;
    const activeTeams = (await db.get("SELECT COUNT(*) as count FROM teams WHERE status = 'ACTIVE'")).count;
    const eliminatedTeams = (await db.get("SELECT COUNT(*) as count FROM teams WHERE status = 'ELIMINATED'")).count;

    const now = Date.now();
    const teamsInside = (await db.get("SELECT COUNT(*) as count FROM room_entries WHERE status = 'ACTIVE' AND expiry_time > ?", [now])).count;
    const completedVisits = (await db.get("SELECT COUNT(*) as count FROM room_entries WHERE status = 'COMPLETED' OR expiry_time <= ?", [now])).count;

    const currentRound = await db.get('SELECT * FROM rounds WHERE status = ? LIMIT 1', ['ACTIVE']) || { round_number: 1, status: 'ACTIVE' };

    // Active rooms occupancy status
    const rooms = await db.all('SELECT * FROM rooms');
    const roomStatus = [];
    for (const r of rooms) {
      const activeEntry = await db.get(`
        SELECT re.*, t.team_id, t.team_name
        FROM room_entries re
        JOIN teams t ON re.team_id = t.id
        WHERE re.room_id = ? AND re.status = 'ACTIVE' AND re.expiry_time > ?
        ORDER BY re.entry_time DESC LIMIT 1
      `, [r.id, now]);

      roomStatus.push({
        room_id: r.id,
        room_code: r.code || r.room_code,
        room_name: r.room_name,
        occupied: !!activeEntry,
        current_team: activeEntry ? {
          team_id: activeEntry.team_id,
          team_name: activeEntry.team_name,
          expiry_time: activeEntry.expiry_time,
          remaining_seconds: Math.max(0, Math.floor((activeEntry.expiry_time - now) / 1000))
        } : null
      });
    }

    const recentLogs = await db.all('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 15');

    res.json({
      success: true,
      server_time: now,
      stats: {
        total_teams: totalTeams,
        active_teams: activeTeams,
        eliminated_teams: eliminatedTeams,
        teams_inside: teamsInside,
        completed_visits: completedVisits,
        current_round: currentRound.round_number
      },
      room_status: roomStatus,
      recent_logs: recentLogs
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve admin overview.' });
  }
});

// Teams Management
app.get('/api/admin/teams', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const teams = await db.all(`
      SELECT t.*, 
        (SELECT COUNT(*) FROM room_entries re WHERE re.team_id = t.id) as total_room_visits
      FROM teams t
      ORDER BY t.score DESC, t.id ASC
    `);
    res.json({ success: true, teams });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to retrieve teams.' });
  }
});

// Create Team
app.post('/api/admin/teams', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const { team_id, team_name, score, password } = req.body;
    if (!team_id || !team_name) {
      return res.status(400).json({ success: false, message: 'Team ID and Team Name are required.' });
    }

    const cleanId = team_id.trim().toUpperCase();
    const cleanName = team_name.trim();
    const rawPass = password ? password.trim() : cleanName;
    const initialScore = parseInt(score, 10) || 0;

    const existing = await db.get('SELECT * FROM teams WHERE UPPER(team_id) = ?', [cleanId]);
    if (existing) {
      return res.status(400).json({ success: false, message: `Team ID ${cleanId} already exists.` });
    }

    const passHash = await bcrypt.hash(rawPass, 10);
    const token = db.generateSecureToken(cleanId);

    const result = await db.run(`
      INSERT INTO teams (team_id, team_name, password_hash, qr_token, score, status, current_round)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1)
    `, [cleanId, cleanName, passHash, token, initialScore]);

    await db.logActivity(req.user.id, req.user.username, 'TEAM_CREATED', `Created ${cleanId} - ${cleanName}`);

    broadcastLeaderboard();
    broadcastEvent('dashboard_update', { type: 'TEAM_CREATED' });

    res.json({
      success: true,
      team: {
        id: result.id,
        team_id: cleanId,
        team_name: cleanName,
        score: initialScore,
        qr_token: token
      }
    });
  } catch (err) {
    console.error('Create team error:', err);
    res.status(500).json({ success: false, message: 'Failed to create team.' });
  }
});

// Edit Team Details
app.put('/api/admin/teams/:id', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const { team_name, score, password } = req.body;
    const teamId = req.params.id;

    const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    let sql = 'UPDATE teams SET team_name = ?, score = ?';
    let params = [team_name || team.team_name, parseInt(score, 10) || 0];

    if (password && password.trim()) {
      const newHash = await bcrypt.hash(password.trim(), 10);
      sql += ', password_hash = ?';
      params.push(newHash);
    }

    sql += ' WHERE id = ?';
    params.push(teamId);

    await db.run(sql, params);

    await db.logActivity(req.user.id, req.user.username, 'TEAM_UPDATED', `Updated team ${team.team_id}`);
    broadcastLeaderboard();

    res.json({ success: true, message: 'Team updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update team.' });
  }
});

// Update Team Score
app.post('/api/admin/teams/:id/score', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const teamId = req.params.id;
    const { new_score } = req.body;

    const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const oldScore = team.score;
    const parsedScore = parseInt(new_score, 10);
    if (isNaN(parsedScore)) {
      return res.status(400).json({ success: false, message: 'Invalid score.' });
    }

    await db.run('UPDATE teams SET score = ? WHERE id = ?', [parsedScore, teamId]);
    await db.run(
      'INSERT INTO score_history (team_id, old_score, new_score, changed_by) VALUES (?, ?, ?, ?)',
      [teamId, oldScore, parsedScore, req.user.username]
    );

    await db.logActivity(
      req.user.id,
      req.user.username,
      'SCORE_CHANGED',
      `Team ${team.team_name} score changed from ${oldScore} to ${parsedScore}`
    );

    broadcastLeaderboard();
    broadcastEvent('score_updated', {
      team_id: team.team_id,
      team_name: team.team_name,
      old_score: oldScore,
      new_score: parsedScore
    });

    res.json({ success: true, old_score: oldScore, new_score: parsedScore });
  } catch (err) {
    console.error('Score update error:', err);
    res.status(500).json({ success: false, message: 'Failed to update score.' });
  }
});

// Eliminate Team
app.post('/api/admin/teams/:id/eliminate', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const teamId = req.params.id;
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    await db.run("UPDATE teams SET status = 'ELIMINATED' WHERE id = ?", [teamId]);
    await db.logActivity(req.user.id, req.user.username, 'TEAM_ELIMINATED', `Eliminated team ${team.team_name} (${team.team_id})`);

    broadcastLeaderboard();
    broadcastEvent('team_status_update', {
      team_id: team.team_id,
      team_name: team.team_name,
      status: 'ELIMINATED'
    });

    res.json({ success: true, message: `Team ${team.team_name} has been eliminated.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to eliminate team.' });
  }
});

// Restore Team
app.post('/api/admin/teams/:id/restore', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const teamId = req.params.id;
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    await db.run("UPDATE teams SET status = 'ACTIVE' WHERE id = ?", [teamId]);
    await db.logActivity(req.user.id, req.user.username, 'TEAM_RESTORED', `Restored team ${team.team_name} (${team.team_id})`);

    broadcastLeaderboard();
    broadcastEvent('team_status_update', {
      team_id: team.team_id,
      team_name: team.team_name,
      status: 'ACTIVE'
    });

    res.json({ success: true, message: `Team ${team.team_name} restored to ACTIVE status.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to restore team.' });
  }
});

// Delete Team
app.delete('/api/admin/teams/:id', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const teamId = req.params.id;
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    await db.run('DELETE FROM teams WHERE id = ?', [teamId]);
    await db.logActivity(req.user.id, req.user.username, 'TEAM_DELETED', `Deleted team ${team.team_name} (${team.team_id})`);

    broadcastLeaderboard();
    broadcastEvent('dashboard_update', { type: 'TEAM_DELETED' });

    res.json({ success: true, message: 'Team deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete team.' });
  }
});

// Generate / Get QR code for team
app.get('/api/admin/teams/:id/qr', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const qrDataUrl = await QRCode.toDataURL(team.qr_token, {
      errorCorrectionLevel: 'H',
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      },
      width: 400
    });

    res.json({
      success: true,
      team_id: team.team_id,
      team_name: team.team_name,
      qr_token: team.qr_token,
      qr_data_url: qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to generate QR.' });
  }
});

// Regenerate QR Token
app.post('/api/admin/teams/:id/regenerate-qr', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const team = await db.get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const newToken = db.generateSecureToken(team.team_id);
    await db.run('UPDATE teams SET qr_token = ? WHERE id = ?', [newToken, team.id]);

    await db.logActivity(req.user.id, req.user.username, 'QR_REGENERATED', `Regenerated QR for ${team.team_id}`);

    res.json({ success: true, qr_token: newToken });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to regenerate QR token.' });
  }
});

// Rounds & Room Settings
app.get('/api/admin/rounds', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const rounds = await db.all('SELECT * FROM rounds ORDER BY round_number ASC');
    const rooms = await db.all('SELECT * FROM rooms ORDER BY id ASC');
    const settings = await db.all('SELECT * FROM room_settings');

    res.json({ success: true, rounds, rooms, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get rounds.' });
  }
});

// Create Round
app.post('/api/admin/rounds', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const { round_number } = req.body;
    const rNum = parseInt(round_number, 10);
    if (!rNum) return res.status(400).json({ success: false, message: 'Invalid round number.' });

    const exists = await db.get('SELECT * FROM rounds WHERE round_number = ?', [rNum]);
    if (exists) return res.status(400).json({ success: false, message: `Round ${rNum} already exists.` });

    const result = await db.run('INSERT INTO rounds (round_number, status) VALUES (?, "PENDING")', [rNum]);
    const roundId = result.id;

    // Insert default room settings
    const rooms = await db.all('SELECT * FROM rooms');
    for (const room of rooms) {
      await db.run(
        'INSERT OR IGNORE INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)',
        [roundId, room.id, 5]
      );
    }

    await db.logActivity(req.user.id, req.user.username, 'ROUND_CREATED', `Created Round ${rNum}`);

    res.json({ success: true, round_id: roundId, round_number: rNum });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create round.' });
  }
});

// Set Active Round
app.post('/api/admin/rounds/:id/activate', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const roundId = req.params.id;
    const round = await db.get('SELECT * FROM rounds WHERE id = ?', [roundId]);
    if (!round) return res.status(404).json({ success: false, message: 'Round not found.' });

    // Mark previous active round as COMPLETED
    await db.run("UPDATE rounds SET status = 'COMPLETED' WHERE status = 'ACTIVE'");
    // Set this round to ACTIVE
    await db.run("UPDATE rounds SET status = 'ACTIVE' WHERE id = ?", [roundId]);

    await db.logActivity(req.user.id, req.user.username, 'ROUND_ACTIVATED', `Round ${round.round_number} is now ACTIVE`);

    broadcastEvent('round_changed', { round_number: round.round_number });
    broadcastEvent('dashboard_update', { type: 'ROUND_ACTIVATED' });

    res.json({ success: true, message: `Round ${round.round_number} is now active.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to activate round.' });
  }
});

// Update Room Time Settings
app.post('/api/admin/room-settings', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const { round_id, room_id, duration_minutes } = req.body;
    const duration = parseInt(duration_minutes, 10);
    if (!duration || duration <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be greater than 0.' });
    }

    await db.run(`
      INSERT INTO room_settings (round_id, room_id, duration_minutes)
      VALUES (?, ?, ?)
      ON CONFLICT(round_id, room_id) DO UPDATE SET duration_minutes = excluded.duration_minutes
    `, [round_id, room_id, duration]);

    await db.logActivity(req.user.id, req.user.username, 'SETTINGS_UPDATED', `Set duration to ${duration}m for round ${round_id}, room ${room_id}`);

    res.json({ success: true, message: 'Room time limit saved successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update room settings.' });
  }
});

// Sub Admins Management
app.get('/api/admin/sub-admins', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const subAdmins = await db.all("SELECT id, username, name, role, assigned_room, created_at FROM users WHERE role = 'SUB_ADMIN'");
    res.json({ success: true, sub_admins: subAdmins });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to retrieve sub-admins.' });
  }
});

// Create Sub Admin
app.post('/api/admin/sub-admins', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const { username, name, password, assigned_room } = req.body;
    if (!username || !password || !assigned_room) {
      return res.status(400).json({ success: false, message: 'ID, Password, and Assigned Room are required.' });
    }

    const cleanUsername = username.trim().toUpperCase();
    const existing = await db.get('SELECT * FROM users WHERE username = ?', [cleanUsername]);
    if (existing) {
      return res.status(400).json({ success: false, message: `Admin ID ${cleanUsername} already exists.` });
    }

    const hash = await bcrypt.hash(password.trim(), 10);
    await db.run(`
      INSERT INTO users (username, password_hash, name, role, assigned_room)
      VALUES (?, ?, ?, 'SUB_ADMIN', ?)
    `, [cleanUsername, hash, name || cleanUsername, assigned_room.toUpperCase()]);

    await db.logActivity(req.user.id, req.user.username, 'SUB_ADMIN_CREATED', `Created sub-admin ${cleanUsername} for ${assigned_room}`);

    res.json({ success: true, message: `Sub-admin ${cleanUsername} created successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create sub-admin.' });
  }
});

// Delete Sub Admin
app.delete('/api/admin/sub-admins/:id', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const user = await db.get("SELECT * FROM users WHERE id = ? AND role = 'SUB_ADMIN'", [id]);
    if (!user) return res.status(404).json({ success: false, message: 'Sub-admin not found.' });

    await db.run('DELETE FROM users WHERE id = ?', [id]);
    await db.logActivity(req.user.id, req.user.username, 'SUB_ADMIN_DELETED', `Deleted sub-admin ${user.username}`);

    res.json({ success: true, message: 'Sub-admin removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete sub-admin.' });
  }
});

// Activity Logs
app.get('/api/admin/logs', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const logs = await db.all('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 100');
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get logs.' });
  }
});

// DANGEROUS RESET EVENT SYSTEM
app.post('/api/admin/reset-event', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const { confirmation_code } = req.body;
    if (confirmation_code !== 'RESET AURORA') {
      return res.status(400).json({
        success: false,
        message: 'Invalid confirmation code. You must type exactly: RESET AURORA'
      });
    }

    // 1. Delete all room entries and active timers
    await db.run('DELETE FROM room_entries');

    // 2. Delete score history
    await db.run('DELETE FROM score_history');

    // 3. Reset all team scores to 0 and status to ACTIVE
    await db.run("UPDATE teams SET score = 0, status = 'ACTIVE', current_round = 1");

    // 4. Reset rounds: Round 1 ACTIVE, others PENDING
    await db.run("UPDATE rounds SET status = 'COMPLETED' WHERE round_number > 1");
    await db.run("UPDATE rounds SET status = 'ACTIVE' WHERE round_number = 1");

    // 5. Log the dangerous reset action
    await db.logActivity(req.user.id, req.user.username, 'EVENT_RESET', 'Entire event data reset by Head Admin');

    // 6. Broadcast event reset
    broadcastLeaderboard();
    broadcastEvent('event_reset', { message: 'The event has been reset by Head Admin.' });
    broadcastEvent('dashboard_update', { type: 'EVENT_RESET' });

    res.json({
      success: true,
      message: 'The Aurora Protocol event data has been successfully reset. Teams and accounts remain intact.'
    });
  } catch (err) {
    console.error('Reset event error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset event.' });
  }
});

// Clear Sample Data / Reseed
app.post('/api/admin/clear-sample-data', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM room_entries');
    await db.run('DELETE FROM score_history');
    await db.run('DELETE FROM teams');
    await db.logActivity(req.user.id, req.user.username, 'CLEARED_TEAMS', 'All sample teams cleared for live event');
    broadcastLeaderboard();
    res.json({ success: true, message: 'All sample teams have been cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to clear sample data.' });
  }
});

app.post('/api/admin/reseed-sample-data', authMiddleware, requireHeadAdmin, async (req, res) => {
  try {
    const sampleTeams = [
      { id: 'AURORA001', name: 'TEAM ALPHA', score: 950 },
      { id: 'AURORA002', name: 'TEAM PHANTOM', score: 910 },
      { id: 'AURORA003', name: 'TEAM SHADOW', score: 875 },
      { id: 'AURORA004', name: 'TEAM VECTOR', score: 820 },
      { id: 'AURORA005', name: 'TEAM HUNTER', score: 780 }
    ];

    for (const t of sampleTeams) {
      const passHash = await bcrypt.hash(t.name, 10);
      const token = db.generateSecureToken(t.id);
      await db.run(`
        INSERT OR REPLACE INTO teams (team_id, team_name, password_hash, qr_token, score, status, current_round)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1)
      `, [t.id, t.name, passHash, token, t.score]);
    }

    await db.logActivity(req.user.id, req.user.username, 'RESEEDED_SAMPLE_DATA', 'Reseeded default 5 teams');
    broadcastLeaderboard();
    res.json({ success: true, message: 'Sample teams reseeded successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to reseed sample data.' });
  }
});

// -------------------------------------------------------------
// HTML ROUTING & DIRECT NAVIGATION
// -------------------------------------------------------------

app.get('/student', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root redirects to portal selector or student by default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server and initialize Database
async function startServer() {
  try {
    await db.initDatabase();
    server.listen(config.PORT, () => {
      console.log(`====================================================`);
      console.log(`  THE AURORA PROTOCOL — EVENT COMMAND CENTER        `);
      console.log(`  Server running at http://localhost:${config.PORT} `);
      console.log(`  Student Portal: http://localhost:${config.PORT}/student `);
      console.log(`  Admin Portal:   http://localhost:${config.PORT}/admin   `);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

startServer();
