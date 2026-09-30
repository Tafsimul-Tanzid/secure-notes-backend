const { Router } = require('express');
const User = require('../models/User');
const Note = require('../models/Note');
const Post = require('../models/Post');
const { authenticate, requireRole } = require('../middleware/auth');
const { HttpError } = require('../middleware/errors');
const { objectId, pick, password, pagination, paginated } = require('../utils/validate');

const router = Router();

// needs to stay above /:id or "interests" gets treated as an id
// scenario 1, any logged in user can see it (only names are returned, no emails)
router.get('/interests', authenticate, async (req, res) => {
  const page = pagination(req.query);
  const [{ data, total }] = await User.groupByInterests(page);
  res.json(paginated(data, total[0]?.count ?? 0, page));
});

// scenario 2, posts are public so no auth
router.get('/:id/posts', async (req, res) => {
  const page = pagination(req.query);
  const [user] = await User.postsOf(objectId(req.params.id), page);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user: { _id: user._id, name: user.name }, ...paginated(user.posts, user.total, page) });
});

// everything below is admin only
router.use(authenticate, requireRole('admin'));

const EDITABLE = ['name', 'email', 'password', 'role', 'interests'];

// sorted by _id so the default index handles it
router.get('/', async (req, res) => {
  const page = pagination(req.query);
  const [users, total] = await Promise.all([
    User.find().sort({ _id: -1 }).skip(page.skip).limit(page.limit),
    User.estimatedDocumentCount(),
  ]);
  res.json(paginated(users, total, page));
});

router.post('/', async (req, res) => {
  const data = pick(req.body, EDITABLE);
  password(data.password);
  const user = await User.create(data);
  res.status(201).json(user);
});

router.get('/:id', async (req, res) => {
  const user = await User.findById(objectId(req.params.id));
  if (!user) throw new HttpError(404, 'User not found');
  res.json(user);
});

router.put('/:id', async (req, res) => {
  const id = objectId(req.params.id);
  const data = pick(req.body, EDITABLE);
  if (data.password !== undefined) password(data.password);
  // stop an admin from demoting themselves and losing access
  if (id.equals(req.user._id) && data.role !== undefined && data.role !== req.user.role) {
    throw new HttpError(403, 'You cannot change your own role');
  }

  const user = await User.findById(id);
  if (!user) throw new HttpError(404, 'User not found');
  user.set(data);
  await user.save(); // save() so the password gets hashed and validators run
  res.json(user);
});

router.delete('/:id', async (req, res) => {
  const id = objectId(req.params.id);
  if (id.equals(req.user._id)) throw new HttpError(403, 'You cannot delete your own account');

  const user = await User.findByIdAndDelete(id);
  if (!user) throw new HttpError(404, 'User not found');
  // clean up their notes and posts too
  await Promise.all([Note.deleteMany({ userId: id }), Post.deleteMany({ userId: id })]);
  res.status(204).end();
});

module.exports = router;
