const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const { HttpError } = require('./errors');

function signToken(user) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user._id),
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

// Checks the token and then loads the user from the db, so if a user is deleted
// or their role changes it applies right away instead of when the token expires.
async function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Missing bearer token');

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }

  req.user = await User.findById(payload.sub).select('-__v').lean();
  if (!req.user) throw new HttpError(401, 'User no longer exists');
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'Forbidden');
    next();
  };
}

module.exports = { signToken, authenticate, requireRole };
