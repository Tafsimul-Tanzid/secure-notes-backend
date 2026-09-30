const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../config');

// Max users listed under each interest. The whole $facet result is one document
// (16MB limit) so we don't want it to grow forever. `count` still has the real number.
const USERS_PER_GROUP = 50;

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'is invalid'],
    },
    // hidden by default, login uses .select('+password') to get it
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    interests: {
      type: [{ type: String, maxlength: 40 }],
      default: [],
      validate: { validator: (v) => v.length <= 20, message: 'at most 20 interests' },
      // lowercase + remove duplicates so "Chess" and "chess" land in the same group
      set: (v) => [...new Set((v || []).map((i) => String(i).trim().toLowerCase()).filter(Boolean))],
    },
  },
  { timestamps: true }
);

// Login looks users up by email, and it also has to be unique.
// Everything else on users goes through _id (profile, get/update/delete, the admin
// list which is sorted by _id, the $match in postsOf) so the default _id index covers it.
// Nothing queries by role or createdAt, so no index for those.
userSchema.index({ email: 1 }, { unique: true });

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, config.bcryptRounds);
});

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.password);
};

// Scenario 1: group users by interest, one aggregate() call.
//
// I left out an index on interests on purpose. There's no filter in this pipeline,
// so every user has to be read to build the groups anyway. A multikey index can't
// cover the query (name isn't in it), so Mongo would walk the whole index and still
// fetch every document, which is slower than just scanning the collection.
userSchema.statics.groupByInterests = function groupByInterests({ skip, limit }) {
  return this.aggregate([
    { $unwind: '$interests' }, // users with no interests drop out here
    {
      $group: {
        _id: '$interests',
        count: { $sum: 1 },
        users: { $firstN: { n: USERS_PER_GROUP, input: { _id: '$_id', name: '$name' } } },
      },
    },
    { $sort: { _id: 1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }, { $project: { _id: 0, interest: '$_id', count: 1, users: 1 } }],
        total: [{ $count: 'count' }],
      },
    },
  ]);
};

// Scenario 2: a user's posts with $lookup, one aggregate() call.
//
// The $match uses the _id index. Both lookups join on posts.userId, which uses the
// { userId: 1, _id: -1 } index on posts. The first one reads the page straight from
// the index already sorted newest first. The second one only counts, and since userId
// is in the index it never has to load the actual posts.
// If the user doesn't exist we just get an empty array back (route sends 404).
userSchema.statics.postsOf = function postsOf(userId, { skip, limit }) {
  const join = { from: 'posts', localField: '_id', foreignField: 'userId' };
  return this.aggregate([
    { $match: { _id: userId } },
    {
      $lookup: {
        ...join,
        pipeline: [{ $sort: { _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { __v: 0 } }],
        as: 'posts',
      },
    },
    { $lookup: { ...join, pipeline: [{ $count: 'count' }], as: 'total' } },
    { $project: { name: 1, posts: 1, total: { $ifNull: [{ $first: '$total.count' }, 0] } } },
  ]);
};

userSchema.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
