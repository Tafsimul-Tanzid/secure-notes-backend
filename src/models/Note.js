const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, default: '', maxlength: 20000 },
  },
  { timestamps: true }
);

// For listing and counting a user's notes (newest first), also used when a user
// gets deleted. userId first for the filter, then _id for the sort, so Mongo reads
// the notes in order and doesn't have to sort them in memory.
//
// I sort by _id instead of createdAt: same order since ObjectIds start with a
// timestamp, and it means the admin "all notes" list just uses the default _id index.
// Getting a single note also goes by _id.
noteSchema.index({ userId: 1, _id: -1 });

noteSchema.set('toJSON', { versionKey: false });

module.exports = mongoose.model('Note', noteSchema);
