const { Router } = require('express');
const Post = require('../models/Post');
const { authenticate } = require('../middleware/auth');
const { pick, pagination, paginated } = require('../utils/validate');

const router = Router();

// public feed, newest first. One user's posts are at GET /api/users/:id/posts
router.get('/', async (req, res) => {
  const page = pagination(req.query);
  const [posts, total] = await Promise.all([
    Post.find()
      .sort({ _id: -1 })
      .skip(page.skip)
      .limit(page.limit)
      .populate({ path: 'userId', select: 'name' }),
    Post.estimatedDocumentCount(),
  ]);
  res.json(paginated(posts, total, page));
});

router.post('/', authenticate, async (req, res) => {
  const post = await Post.create({ ...pick(req.body, ['title', 'content']), userId: req.user._id });
  res.status(201).json(post);
});

module.exports = router;
