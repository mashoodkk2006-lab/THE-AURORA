const path = require('path');
const os = require('os');

// Database configuration
// MySQL: MYSQL_URL, MYSQL_PUBLIC_URL, or DATABASE_URL starting with mysql:// (or individual MYSQLHOST, etc.)
// PostgreSQL: DATABASE_URL starting with postgres:// or postgresql://
// SQLite: fallback to local data/aurora.sqlite
const MYSQL_URL = process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL || (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('mysql') ? process.env.DATABASE_URL : null);
const DATABASE_URL = process.env.DATABASE_URL || null;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'aurora.sqlite');

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'aurora_protocol_classified_sec_token_2026',
  MYSQL_URL,
  DATABASE_URL,
  DB_PATH,
  MYSQL_CONFIG: {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST,
    user: process.env.MYSQLUSER || process.env.MYSQL_USER,
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE,
    port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT, 10) || 3306
  },
  HEAD_ADMIN: {
    username: 'MASHOOD',
    password: 'THEAURORAPROTOCOL',
    role: 'HEAD_ADMIN'
  },
  DEFAULT_ROOMS: [
    { code: 'POLICE', name: 'POLICE INVESTIGATION ROOM' },
    { code: 'LAB', name: 'SCIENTIST LAB' }
  ]
};
