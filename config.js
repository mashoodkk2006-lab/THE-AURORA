const path = require('path');
const os = require('os');

// On Railway and most cloud platforms, /tmp is always writable.
// Locally, use the data/ folder for persistence.
const isProduction = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const DB_PATH = isProduction
  ? path.join(os.tmpdir(), 'aurora.sqlite')
  : path.join(__dirname, 'data', 'aurora.sqlite');

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
