const { Router } = require('express');
const Note = require('../models/Note');
const { authenticate } = require('../middleware/auth');
const { HttpError } = require('../middleware/errors');
const { objectId, pick, pagination, paginated } = require('../utils/validate');

const router = Router();
router.use(authenticate);

const isAdmin = (req) => req.user.role === 'admin';

// Users get their own notes. Admins get everyone's, or one user's with ?userId=
router.get('/', async (req, res) => {
  const page = pagination(req.query);

  let filter = { userId: req.user._id };
  if (isAdmin(req)) filter = req.query.userId ? { userId: objectId(req.query.userId, 'userId') } : {};

  const query = Note.find(filter).sort({ _id: -1 }).skip(page.skip).limit(page.limit);
  // admins need to see who wrote each note
  if (isAdmin(req)) query.populate({ path: 'userId', select: 'name email' });

  const [notes, total] = await Promise.all([
    query,
    // no filter = just read the count from collection metadata
    filter.userId ? Note.countDocuments(filter) : Note.estimatedDocumentCount(),
  ]);
  res.json(paginated(notes, total, page));
});

router.post('/', async (req, res) => {
  const note = await Note.create({ ...pick(req.body, ['title', 'content']), userId: req.user._id });
  res.status(201).json(note);
});

// admins can open any note, users only their own
router.get('/:id', async (req, res) => {
  const filter = { _id: objectId(req.params.id) };
  if (!isAdmin(req)) filter.userId = req.user._id;

  const note = await Note.findOne(filter);
  if (!note) throw new HttpError(404, 'Note not found');
  res.json(note);
});

// Only the owner can edit or delete, admins included (they can only view other people's notes).
// userId is in the filter, so someone else's note just comes back as a 404.
router.put('/:id', async (req, res) => {
  const note = await Note.findOneAndUpdate(
    { _id: objectId(req.params.id), userId: req.user._id },
    pick(req.body, ['title', 'content']),
    { new: true, runValidators: true }
  );
  if (!note) throw new HttpError(404, 'Note not found');
  res.json(note);
});

router.delete('/:id', async (req, res) => {
  const { deletedCount } = await Note.deleteOne({ _id: objectId(req.params.id), userId: req.user._id });
  if (!deletedCount) throw new HttpError(404, 'Note not found');
  res.status(204).end();
});

module.exports = router;
