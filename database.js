const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('./config');

let dbDriver = 'sqlite';
let sqliteDb = null;
let pgPool = null;
let mysqlPool = null;

// Determine which database driver to use: MySQL > PostgreSQL > SQLite (fallback)
const hasMySqlEnv = config.MYSQL_URL || (config.MYSQL_CONFIG && config.MYSQL_CONFIG.host && config.MYSQL_CONFIG.database);
const hasPgEnv = config.DATABASE_URL && (config.DATABASE_URL.startsWith('postgres') || config.DATABASE_URL.startsWith('postgresql'));

if (hasMySqlEnv) {
  dbDriver = 'mysql';
  const mysql = require('mysql2/promise');

  if (config.MYSQL_URL) {
    const isLocal = config.MYSQL_URL.includes('localhost') || config.MYSQL_URL.includes('127.0.0.1');
    mysqlPool = mysql.createPool({
      uri: config.MYSQL_URL,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: isLocal ? undefined : { rejectUnauthorized: false }
    });
  } else {
    const isLocal = config.MYSQL_CONFIG.host && (config.MYSQL_CONFIG.host.includes('localhost') || config.MYSQL_CONFIG.host.includes('127.0.0.1'));
    mysqlPool = mysql.createPool({
      host: config.MYSQL_CONFIG.host,
      user: config.MYSQL_CONFIG.user,
      password: config.MYSQL_CONFIG.password,
      database: config.MYSQL_CONFIG.database,
      port: config.MYSQL_CONFIG.port || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: isLocal ? undefined : { rejectUnauthorized: false }
    });
  }

  console.log('[DB] Configured for MySQL (Cloud / Remote Database)');
} else if (hasPgEnv) {
  dbDriver = 'postgres';
  const { Pool } = require('pg');
  const isLocalPg = config.DATABASE_URL.includes('localhost') || config.DATABASE_URL.includes('127.0.0.1');

  pgPool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: isLocalPg ? false : { rejectUnauthorized: false }
  });

  pgPool.on('error', (err) => {
    console.error('[DB ERROR] Unexpected PostgreSQL error on idle client:', err);
  });

  console.log('[DB] Configured for PostgreSQL (Cloud Database)');
} else {
  dbDriver = 'sqlite';
  const sqlite3 = require('sqlite3').verbose();

  // Ensure parent directory exists to prevent SQLITE_CANTOPEN
  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  sqliteDb = new sqlite3.Database(config.DB_PATH, (err) => {
    if (err) {
      console.error(`[DB ERROR] Failed to connect to SQLite at ${config.DB_PATH}:`, err.message);
    } else {
      console.log(`[DB] Connected successfully to SQLite database at ${config.DB_PATH}`);
    }
  });
}

function generateSecureToken(teamId) {
  const hash = crypto.randomBytes(12).toString('hex');
  return `AURORA_${teamId}_${hash}`;
}

// Convert SQLite/ANSI queries for PostgreSQL ($1, $2, ...)
function convertToPgSql(sql) {
  let paramIndex = 1;
  let pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
  pgSql = pgSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
  return pgSql;
}

// Convert SQLite/ANSI queries for MySQL (ON DUPLICATE KEY UPDATE)
function convertToMySql(sql) {
  let mySql = sql;
  // Replace ON CONFLICT (...) DO NOTHING with ON DUPLICATE KEY UPDATE id=id
  mySql = mySql.replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/gi, 'ON DUPLICATE KEY UPDATE id=id');
  // Replace ON CONFLICT(...) DO UPDATE SET ... with ON DUPLICATE KEY UPDATE ...
  mySql = mySql.replace(/ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+(.*)/gis, (match, updateClause) => {
    const convertedClause = updateClause.replace(/excluded\.(\w+)/gi, (m, col) => `VALUES(${col})`);
    return `ON DUPLICATE KEY UPDATE ${convertedClause}`;
  });
  return mySql;
}

// Unified Promise wrapper for INSERT, UPDATE, DELETE
function run(sql, params = []) {
  if (dbDriver === 'mysql') {
    return new Promise(async (resolve, reject) => {
      try {
        const mySql = convertToMySql(sql);
        const [result] = await mysqlPool.query(mySql, params);
        resolve({ id: result.insertId || null, changes: result.affectedRows });
      } catch (err) {
        reject(err);
      }
    });
  }

  if (dbDriver === 'postgres') {
    return new Promise(async (resolve, reject) => {
      try {
        let pgSql = convertToPgSql(sql);
        const isInsert = /^\s*INSERT\s+/i.test(sql);
        if (isInsert && !/RETURNING/i.test(pgSql)) {
          pgSql += ' RETURNING id';
        }
        const res = await pgPool.query(pgSql, params);
        const lastID = res.rows && res.rows[0] && res.rows[0].id !== undefined ? res.rows[0].id : null;
        resolve({ id: lastID, changes: res.rowCount });
      } catch (err) {
        reject(err);
      }
    });
  }

  // SQLite implementation
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// Unified Promise wrapper for single row queries
function get(sql, params = []) {
  if (dbDriver === 'mysql') {
    return new Promise(async (resolve, reject) => {
      try {
        const mySql = convertToMySql(sql);
        const [rows] = await mysqlPool.query(mySql, params);
        resolve(rows && rows[0] ? rows[0] : null);
      } catch (err) {
        reject(err);
      }
    });
  }

  if (dbDriver === 'postgres') {
    return new Promise(async (resolve, reject) => {
      try {
        const pgSql = convertToPgSql(sql);
        const res = await pgPool.query(pgSql, params);
        resolve(res.rows[0] || null);
      } catch (err) {
        reject(err);
      }
    });
  }

  // SQLite implementation
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

// Unified Promise wrapper for multi-row queries
function all(sql, params = []) {
  if (dbDriver === 'mysql') {
    return new Promise(async (resolve, reject) => {
      try {
        const mySql = convertToMySql(sql);
        const [rows] = await mysqlPool.query(mySql, params);
        resolve(rows || []);
      } catch (err) {
        reject(err);
      }
    });
  }

  if (dbDriver === 'postgres') {
    return new Promise(async (resolve, reject) => {
      try {
        const pgSql = convertToPgSql(sql);
        const res = await pgPool.query(pgSql, params);
        resolve(res.rows || []);
      } catch (err) {
        reject(err);
      }
    });
  }

  // SQLite implementation
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function initDatabase() {
  if (dbDriver === 'mysql') {
    await initMysql();
  } else if (dbDriver === 'postgres') {
    await initPostgres();
  } else {
    await initSqlite();
  }
  await seedDefaultData();
}

async function initMysql() {
  await run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(191) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      role VARCHAR(50) NOT NULL,
      assigned_room VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id VARCHAR(100) UNIQUE NOT NULL,
      team_name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      qr_token VARCHAR(255) UNIQUE NOT NULL,
      score INT DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      current_round INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      round_number INT UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      room_code VARCHAR(100) UNIQUE NOT NULL,
      room_name VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS room_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      round_id INT NOT NULL,
      room_id INT NOT NULL,
      duration_minutes INT NOT NULL DEFAULT 5,
      FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      UNIQUE KEY unique_round_room (round_id, room_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS room_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      round_id INT NOT NULL,
      room_id INT NULL,
      sub_admin_id INT NULL,
      entry_time BIGINT NOT NULL,
      expiry_time BIGINT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL,
      FOREIGN KEY (sub_admin_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS score_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      old_score INT NOT NULL,
      new_score INT NOT NULL,
      changed_by VARCHAR(255) NOT NULL,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(255),
      action VARCHAR(100) NOT NULL,
      details TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function initSqlite() {
  await run('PRAGMA foreign_keys = ON;');
  await run('PRAGMA journal_mode = WAL;');

  await run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT
    );
  `);

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

  await run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_number INTEGER UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACTIVE', 'COMPLETED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT UNIQUE NOT NULL,
      room_name TEXT NOT NULL
    );
  `);

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

  await run(`
    CREATE TABLE IF NOT EXISTS room_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      round_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      sub_admin_id INTEGER,
      entry_time INTEGER NOT NULL,
      expiry_time INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE,
      FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL,
      FOREIGN KEY(sub_admin_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

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
}

async function initPostgres() {
  await run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name VARCHAR(255),
      role VARCHAR(50) NOT NULL CHECK(role IN ('HEAD_ADMIN', 'SUB_ADMIN')),
      assigned_room VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      team_id VARCHAR(100) UNIQUE NOT NULL,
      team_name VARCHAR(255) NOT NULL,
      password_hash TEXT NOT NULL,
      qr_token VARCHAR(255) UNIQUE NOT NULL,
      score INTEGER DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ELIMINATED')),
      current_round INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      round_number INTEGER UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACTIVE', 'COMPLETED')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      room_code VARCHAR(100) UNIQUE NOT NULL,
      room_name VARCHAR(255) NOT NULL
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS room_settings (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      duration_minutes INTEGER NOT NULL DEFAULT 5,
      UNIQUE(round_id, room_id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS room_entries (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      sub_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      entry_time BIGINT NOT NULL,
      expiry_time BIGINT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS score_history (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      old_score INTEGER NOT NULL,
      new_score INTEGER NOT NULL,
      changed_by VARCHAR(255) NOT NULL,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      username VARCHAR(255),
      action VARCHAR(100) NOT NULL,
      details TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
    const existingRoom = await get('SELECT id FROM rooms WHERE room_code = ?', [r.code]);
    if (!existingRoom) {
      await run('INSERT INTO rooms (room_code, room_name) VALUES (?, ?)', [r.code, r.name]);
    }
  }
  const policeRoom = await get('SELECT id FROM rooms WHERE room_code = ?', ['POLICE']);
  const labRoom = await get('SELECT id FROM rooms WHERE room_code = ?', ['LAB']);

  // 3. Rounds (1, 2, 3)
  for (let rNum = 1; rNum <= 3; rNum++) {
    const existingRound = await get('SELECT id FROM rounds WHERE round_number = ?', [rNum]);
    if (!existingRound) {
      const status = rNum === 1 ? 'ACTIVE' : 'PENDING';
      await run('INSERT INTO rounds (round_number, status) VALUES (?, ?)', [rNum, status]);
    }
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
    const existingPolice = await get('SELECT id FROM room_settings WHERE round_id = ? AND room_id = ?', [round.id, policeRoom.id]);
    if (!existingPolice) {
      await run('INSERT INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)', [round.id, policeRoom.id, policeDuration]);
    }
    const existingLab = await get('SELECT id FROM room_settings WHERE round_id = ? AND room_id = ?', [round.id, labRoom.id]);
    if (!existingLab) {
      await run('INSERT INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)', [round.id, labRoom.id, labDuration]);
    }
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

  // 6. Check if system has already completed initial setup
  // CRITICAL: We DO NOT auto-seed sample teams if setup has already been initialized!
  const initSetting = await get('SELECT setting_value FROM system_settings WHERE setting_key = ?', ['initial_setup_completed']);
  const teamCount = await get('SELECT COUNT(*) as count FROM teams');
  const count = parseInt(teamCount.count, 10);

  if (!initSetting) {
    if (count === 0) {
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
      console.log('[DB] Seeded initial 5 demo teams for fresh setup.');
    }

    await run(
      'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)',
      ['initial_setup_completed', 'true']
    );
  } else {
    console.log(`[DB] System already initialized. Preserving existing ${count} team(s). Auto-seeding skipped.`);
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
  db: {
    run,
    get,
    all
  },
  run,
  get,
  all,
  initDatabase,
  generateSecureToken,
  logActivity
};
