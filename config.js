const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'aurora_protocol_classified_sec_token_2026',
  DB_PATH: path.join(__dirname, 'data', 'aurora.sqlite'),
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
