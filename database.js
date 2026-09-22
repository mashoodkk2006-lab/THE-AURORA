const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('./config');

const db = new sqlite3.Database(config.DB_PATH);

// Helper promise wrappers for sqlite3
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function generateSecureToken(teamId) {
  const hash = crypto.randomBytes(12).toString('hex');
  return `AURORA_${teamId}_${hash}`;
}

async function initDatabase() {
  // Enable foreign keys and WAL mode for better concurrency
  await run('PRAGMA foreign_keys = ON;');
  await run('PRAGMA journal_mode = WAL;');

  // Users table (Head Admin and Sub Admins)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL CHECK(role IN ('HEAD_ADMIN', 'SUB_ADMIN')),
      assigned_room TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Teams table
  await run(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT UNIQUE NOT NULL,
      team_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      qr_token TEXT UNIQUE NOT NULL,
      score INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ELIMINATED')),
      current_round INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Rounds table
  await run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_number INTEGER UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACTIVE', 'COMPLETED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Rooms table
  await run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT UNIQUE NOT NULL,
      room_name TEXT NOT NULL
    );
  `);

  // Room settings per round
  await run(`
    CREATE TABLE IF NOT EXISTS room_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 5,
      FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE,
      FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      UNIQUE(round_id, room_id)
    );
  `);

  // Room entries (authoritative tracking of TEAM + ROUND + ROOM)
  await run(`
    CREATE TABLE IF NOT EXISTS room_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      round_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      sub_admin_id INTEGER,
      entry_time INTEGER NOT NULL,      -- UTC timestamp in milliseconds
      expiry_time INTEGER NOT NULL,     -- UTC timestamp in milliseconds
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE,
      FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL,
      FOREIGN KEY(sub_admin_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Score History
  await run(`
    CREATE TABLE IF NOT EXISTS score_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      old_score INTEGER NOT NULL,
      new_score INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
    );
  `);

  // Activity Logs
  await run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default data
  await seedDefaultData();
}

async function seedDefaultData() {
  // 1. Head Admin
  const headAdmin = await get('SELECT * FROM users WHERE username = ?', [config.HEAD_ADMIN.username]);
  if (!headAdmin) {
    const hash = await bcrypt.hash(config.HEAD_ADMIN.password, 10);
    await run(
      'INSERT INTO users (username, password_hash, name, role, assigned_room) VALUES (?, ?, ?, ?, ?)',
      [config.HEAD_ADMIN.username, hash, 'Head Administrator', 'HEAD_ADMIN', null]
    );
  }

  // 2. Rooms
  for (const r of config.DEFAULT_ROOMS) {
    await run(
      'INSERT OR IGNORE INTO rooms (room_code, room_name) VALUES (?, ?)',
      [r.code, r.name]
    );
  }
  const policeRoom = await get('SELECT id FROM rooms WHERE room_code = ?', ['POLICE']);
  const labRoom = await get('SELECT id FROM rooms WHERE room_code = ?', ['LAB']);

  // 3. Rounds (1, 2, 3)
  for (let rNum = 1; rNum <= 3; rNum++) {
    const status = rNum === 1 ? 'ACTIVE' : 'PENDING';
    await run('INSERT OR IGNORE INTO rounds (round_number, status) VALUES (?, ?)', [rNum, status]);
  }

  // 4. Default Room Settings
  const rounds = await all('SELECT * FROM rounds ORDER BY round_number ASC');
  for (const round of rounds) {
    let policeDuration = 5;
    let labDuration = 7;
    if (round.round_number === 2) {
      policeDuration = 6;
      labDuration = 5;
    }
    await run(
      'INSERT OR IGNORE INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)',
      [round.id, policeRoom.id, policeDuration]
    );
    await run(
      'INSERT OR IGNORE INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)',
      [round.id, labRoom.id, labDuration]
    );
  }

  // 5. Seed Sub Admins
  const subPolice = await get('SELECT * FROM users WHERE username = ?', ['POLICE01']);
  if (!subPolice) {
    const hash = await bcrypt.hash('SecurePassword', 10);
    await run(
      'INSERT INTO users (username, password_hash, name, role, assigned_room) VALUES (?, ?, ?, ?, ?)',
      ['POLICE01', hash, 'Rahul (Police Room)', 'SUB_ADMIN', 'POLICE']
    );
  }

  const subLab = await get('SELECT * FROM users WHERE username = ?', ['LAB01']);
  if (!subLab) {
    const hash = await bcrypt.hash('SecurePassword', 10);
    await run(
      'INSERT INTO users (username, password_hash, name, role, assigned_room) VALUES (?, ?, ?, ?, ?)',
      ['LAB01', hash, 'Ameen (Scientist Lab)', 'SUB_ADMIN', 'LAB']
    );
  }

  // 6. Seed Sample Teams if teams table is empty
  const teamCount = await get('SELECT COUNT(*) as count FROM teams');
  if (teamCount.count === 0) {
    const sampleTeams = [
      { id: 'AURORA001', name: 'TEAM ALPHA', score: 950 },
      { id: 'AURORA002', name: 'TEAM PHANTOM', score: 910 },
      { id: 'AURORA003', name: 'TEAM SHADOW', score: 875 },
      { id: 'AURORA004', name: 'TEAM VECTOR', score: 820 },
      { id: 'AURORA005', name: 'TEAM HUNTER', score: 780 }
    ];

    for (const t of sampleTeams) {
      const passHash = await bcrypt.hash(t.name, 10);
      const token = generateSecureToken(t.id);
      await run(
        'INSERT INTO teams (team_id, team_name, password_hash, qr_token, score, status, current_round) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [t.id, t.name, passHash, token, t.score, 'ACTIVE', 1]
      );
    }
  }
}

// Log activity helper
async function logActivity(userId, username, action, details) {
  try {
    await run(
      'INSERT INTO activity_logs (user_id, username, action, details) VALUES (?, ?, ?, ?)',
      [userId || null, username || 'SYSTEM', action, typeof details === 'object' ? JSON.stringify(details) : details]
    );
  } catch (err) {
    console.error('Failed to write activity log:', err);
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initDatabase,
  generateSecureToken,
  logActivity
};
