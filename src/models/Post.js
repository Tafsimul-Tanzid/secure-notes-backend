const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, default: '', maxlength: 20000 },
  },
  { timestamps: true }
);

// Used by the $lookup in User.postsOf and when a user gets deleted.
// { userId: 1 } alone would work for the join, but then a user's posts would have
// to be sorted in memory. Adding _id: -1 means they come out already sorted.
// The public feed sorts by _id so it doesn't need anything extra.
postSchema.index({ userId: 1, _id: -1 });

postSchema.set('toJSON', { versionKey: false });

module.exports = mongoose.model('Post', postSchema);
