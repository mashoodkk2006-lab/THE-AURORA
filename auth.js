const jwt = require('jsonwebtoken');
const config = require('./config');

function signToken(payload) {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '12h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Extract token from Authorization header or cookie
function extractToken(req) {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  if (req.cookies && req.cookies.aurora_token) {
    return req.cookies.aurora_token;
  }
  return null;
}

function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Access denied.' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, message: 'Session expired or invalid token.' });
  }

  req.user = decoded;
  next();
}

function requireHeadAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'HEAD_ADMIN') {
    return res.status(403).json({ success: false, message: 'Restricted access: Head Admin permission required.' });
  }
  next();
}

function requireSubAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'SUB_ADMIN' && req.user.role !== 'HEAD_ADMIN')) {
    return res.status(403).json({ success: false, message: 'Restricted access: Room Volunteer or Admin permission required.' });
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.user || req.user.role !== 'STUDENT') {
    return res.status(403).json({ success: false, message: 'Restricted access: Student permission required.' });
  }
  next();
}

module.exports = {
  signToken,
  verifyToken,
  authMiddleware,
  requireHeadAdmin,
  requireSubAdmin,
  requireStudent
};
