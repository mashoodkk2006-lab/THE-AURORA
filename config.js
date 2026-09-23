const path = require('path');
const os = require('os');

// On Render, Railway, and cloud platforms, /tmp is always writable.
// If DB_PATH is explicitly set (e.g., persistent disk mount), respect it.
const isProduction = process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH || (isProduction
  ? path.join(os.tmpdir(), 'aurora.sqlite')
  : path.join(__dirname, 'data', 'aurora.sqlite'));

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'aurora_protocol_classified_sec_token_2026',
  DB_PATH,
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
