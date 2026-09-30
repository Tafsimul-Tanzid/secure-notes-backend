const mongoose = require('mongoose');
const User = require('./models/User');
const Note = require('./models/Note');
const Post = require('./models/Post');

// indexes are handled by syncIndexes() in connect()
mongoose.set('autoIndex', false);

async function connect(uri) {
  await mongoose.connect(uri);
  // creates missing indexes and drops any that aren't in the schemas anymore
  for (const model of [User, Note, Post]) await model.syncIndexes();
}

module.exports = { connect, disconnect: () => mongoose.disconnect() };
