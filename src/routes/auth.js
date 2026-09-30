const { Router } = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { signToken, authenticate } = require('../middleware/auth');
const { HttpError } = require('../middleware/errors');
const { pick, password } = require('../utils/validate');

const router = Router();

// basic brute force protection for login/register
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// When the email doesn't exist we still compare against this, so the response
// takes about the same time and you can't tell which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

router.post('/register', authLimiter, async (req, res) => {
  const data = pick(req.body, ['name', 'email', 'password', 'interests']);
  password(data.password);
  // always a normal user here, only an admin can create another admin
  const user = await User.create({ ...data, role: 'user' });
  res.status(201).json({ token: signToken(user), user });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password: plain } = req.body ?? {};
  if (typeof email !== 'string' || typeof plain !== 'string') {
    throw new HttpError(400, 'email and password are required');
  }
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password');
  const ok = user ? await user.verifyPassword(plain) : await bcrypt.compare(plain, DUMMY_HASH).then(() => false);
  if (!ok) throw new HttpError(401, 'Invalid email or password');
  res.json({ token: signToken(user), user });
});

// authenticate already loaded the user
router.get('/me', authenticate, (req, res) => {
  res.json(req.user);
});

module.exports = router;
