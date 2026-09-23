const path = require('path');

// ─── Database Configuration ───────────────────────────────────────────────────
// MySQL is REQUIRED. Configure via:
//   MYSQL_URL=mysql://user:pass@host:3306/dbname
// OR individual variables:
//   MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE, MYSQLPORT
const MYSQL_URL =
  process.env.MYSQL_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('mysql')
    ? process.env.DATABASE_URL
    : null);

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'aurora_protocol_classified_sec_token_2026',
  MYSQL_URL,
  MYSQL_CONFIG: {
    host:     process.env.MYSQLHOST     || process.env.MYSQL_HOST,
    user:     process.env.MYSQLUSER     || process.env.MYSQL_USER,
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE,
    port:     parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT, 10) || 3306
  },
  HEAD_ADMIN: {
    username: 'MASHOOD',
    password: 'THEAURORAPROTOCOL',
    role: 'HEAD_ADMIN'
  },
  DEFAULT_ROOMS: [
    { code: 'POLICE', name: 'POLICE INVESTIGATION ROOM' },
    { code: 'LAB',    name: 'SCIENTIST LAB' }
  ]
};
