const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('./config');

// ─── Startup Guard ────────────────────────────────────────────────────────────
// MySQL is REQUIRED. Exit immediately if credentials are not configured.
const hasMySqlEnv =
  config.MYSQL_URL ||
  (config.MYSQL_CONFIG &&
    config.MYSQL_CONFIG.host &&
    config.MYSQL_CONFIG.database);

if (!hasMySqlEnv) {
  console.error('[DB FATAL] MySQL credentials are not configured.');
  console.error('[DB FATAL] Please set MYSQL_URL or MYSQLHOST/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE in your .env file.');
  process.exit(1);
}

// ─── MySQL Pool ───────────────────────────────────────────────────────────────
const mysql = require('mysql2/promise');

let mysqlPool;

if (config.MYSQL_URL) {
  let connectionUrl = config.MYSQL_URL.trim();
  // Strip unsupported TiDB query parameters like sslaccept if present
  if (connectionUrl.includes('sslaccept=')) {
    connectionUrl = connectionUrl.replace(/[?&]sslaccept=[^&]+/gi, '');
  }

  const isLocal =
    connectionUrl.includes('localhost') ||
    connectionUrl.includes('127.0.0.1');

  try {
    const parsedUrl = new URL(connectionUrl.startsWith('mysql://') ? connectionUrl : `mysql://${connectionUrl}`);
    console.log(`[DB] Target MySQL Host: ${parsedUrl.hostname}, Port: ${parsedUrl.port || 3306}, Database: ${parsedUrl.pathname.replace(/^\//, '') || 'default'}`);
  } catch (e) {
    console.log('[DB] Parsing MySQL URL for debug display...');
  }

  mysqlPool = mysql.createPool({
    uri: connectionUrl,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: isLocal ? undefined : { minVersion: 'TLSv1.2', rejectUnauthorized: false }
  });
} else {
  const isLocal =
    config.MYSQL_CONFIG.host &&
    (config.MYSQL_CONFIG.host.includes('localhost') ||
      config.MYSQL_CONFIG.host.includes('127.0.0.1'));

  console.log(`[DB] Target MySQL Host: ${config.MYSQL_CONFIG.host}, Port: ${config.MYSQL_CONFIG.port || 3306}, Database: ${config.MYSQL_CONFIG.database}`);

  mysqlPool = mysql.createPool({
    host: config.MYSQL_CONFIG.host,
    user: config.MYSQL_CONFIG.user,
    password: config.MYSQL_CONFIG.password,
    database: config.MYSQL_CONFIG.database,
    port: config.MYSQL_CONFIG.port || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: isLocal ? undefined : { minVersion: 'TLSv1.2', rejectUnauthorized: false }
  });
}

console.log('[DB] Configured for MySQL');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSecureToken(teamId) {
  const hash = crypto.randomBytes(12).toString('hex');
  return `AURORA_${teamId}_${hash}`;
}

/**
 * Convert ANSI/SQLite conflict syntax to MySQL syntax.
 * Handles:
 *   INSERT OR IGNORE INTO  →  INSERT IGNORE INTO
 *   ON CONFLICT(...) DO NOTHING  →  ON DUPLICATE KEY UPDATE id=id
 *   ON CONFLICT(...) DO UPDATE SET ...  →  ON DUPLICATE KEY UPDATE ...
 */
function convertToMySql(sql) {
  let mySql = sql;
  mySql = mySql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO');
  mySql = mySql.replace(
    /ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/gi,
    'ON DUPLICATE KEY UPDATE id=id'
  );
  mySql = mySql.replace(
    /ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+(.*)/gis,
    (match, updateClause) => {
      const converted = updateClause.replace(
        /excluded\.(\w+)/gi,
        (m, col) => `VALUES(${col})`
      );
      return `ON DUPLICATE KEY UPDATE ${converted}`;
    }
  );
  return mySql;
}

// ─── Unified DB Interface ─────────────────────────────────────────────────────

/** Execute INSERT / UPDATE / DELETE — returns { id, changes } */
function run(sql, params = []) {
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

/** Fetch a single row — returns row object or null */
function get(sql, params = []) {
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

/** Fetch all matching rows — returns array (empty if none) */
function all(sql, params = []) {
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

// ─── Schema Init ──────────────────────────────────────────────────────────────

async function initDatabase() {
  await initMysql();
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

// ─── Seed Default Data ────────────────────────────────────────────────────────

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
    const existingPolice = await get(
      'SELECT id FROM room_settings WHERE round_id = ? AND room_id = ?',
      [round.id, policeRoom.id]
    );
    if (!existingPolice) {
      await run(
        'INSERT INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)',
        [round.id, policeRoom.id, policeDuration]
      );
    }
    const existingLab = await get(
      'SELECT id FROM room_settings WHERE round_id = ? AND room_id = ?',
      [round.id, labRoom.id]
    );
    if (!existingLab) {
      await run(
        'INSERT INTO room_settings (round_id, room_id, duration_minutes) VALUES (?, ?, ?)',
        [round.id, labRoom.id, labDuration]
      );
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

  // 6. One-time initial setup guard
  const initSetting = await get(
    'SELECT setting_value FROM system_settings WHERE setting_key = ?',
    ['initial_setup_completed']
  );
  const teamCount = await get('SELECT COUNT(*) as count FROM teams');
  const count = parseInt(teamCount.count, 10);

  if (!initSetting) {
    if (count === 0) {
      const sampleTeams = [
        { id: 'AURORA001', name: 'TEAM ALPHA',   score: 950 },
        { id: 'AURORA002', name: 'TEAM PHANTOM',  score: 910 },
        { id: 'AURORA003', name: 'TEAM SHADOW',   score: 875 },
        { id: 'AURORA004', name: 'TEAM VECTOR',   score: 820 },
        { id: 'AURORA005', name: 'TEAM HUNTER',   score: 780 }
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

// ─── Activity Logger ──────────────────────────────────────────────────────────

async function logActivity(userId, username, action, details) {
  try {
    await run(
      'INSERT INTO activity_logs (user_id, username, action, details) VALUES (?, ?, ?, ?)',
      [
        userId || null,
        username || 'SYSTEM',
        action,
        typeof details === 'object' ? JSON.stringify(details) : details
      ]
    );
  } catch (err) {
    console.error('Failed to write activity log:', err);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  db: { run, get, all },
  run,
  get,
  all,
  initDatabase,
  generateSecureToken,
  logActivity
};
