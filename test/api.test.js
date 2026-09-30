// Runs against a real MongoDB. The database gets dropped at the start and end, so this
// uses its own TEST_MONGODB_URI and never MONGODB_URI (which might be the hosted db).
process.env.JWT_SECRET ||= 'test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/secure_notes_test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const db = require('../src/db');
const app = require('../src/app');
const User = require('../src/models/User');
const Note = require('../src/models/Note');
const Post = require('../src/models/Post');

let server;
let base;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

const register = (name, email, extra = {}) =>
  call('POST', '/api/auth/register', { body: { name, email, password: 'password123', ...extra } });

// collects every db call mongoose makes while fn runs, like "users.aggregate"
async function dbCallsDuring(fn) {
  const calls = [];
  mongoose.set('debug', (collection, method) => calls.push(`${collection}.${method}`));
  try {
    await fn();
  } finally {
    mongoose.set('debug', false);
  }
  return calls;
}

// pulls stage names, index names and $lookup info out of an explain() result
function plan(explain) {
  const stages = new Set();
  const indexes = new Set();
  const lookups = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.stage === 'string') stages.add(node.stage);
    if (typeof node.indexName === 'string') indexes.add(node.indexName);
    if (node.$lookup && 'indexesUsed' in node) lookups.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'rejectedPlans' && key !== 'allPlansExecution') walk(value);
    }
  })(explain);
  return { stages: [...stages], indexes: [...indexes], lookups };
}

let admin, alice, bob, carol;

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await db.connect(process.env.MONGODB_URI);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  await User.create({ name: 'Admin', email: 'admin@test.io', password: 'adminpass1', role: 'admin' });
  admin = (await call('POST', '/api/auth/login', { body: { email: 'admin@test.io', password: 'adminpass1' } })).body;
  alice = (await register('Alice', 'alice@test.io', { interests: ['Chess', 'reading'] })).body;
  bob = (await register('Bob', 'bob@test.io', { interests: ['reading', 'coding'] })).body;
  carol = (await register('Carol', 'carol@test.io', { interests: ['chess'] })).body;
});

after(async () => {
  server?.close();
  await mongoose.connection.dropDatabase();
  await db.disconnect();
});

test('indexes: exactly the declared schema.index() set exists', async () => {
  const keys = async (name) => (await mongoose.connection.collection(name).indexes()).map((i) => i.key);
  assert.deepEqual(await keys('users'), [{ _id: 1 }, { email: 1 }]);
  assert.deepEqual(await keys('notes'), [{ _id: 1 }, { userId: 1, _id: -1 }]);
  assert.deepEqual(await keys('posts'), [{ _id: 1 }, { userId: 1, _id: -1 }]);
});

test('auth: register, login, hashing, token checks, no password leakage', async () => {
  assert.ok(alice.token);
  assert.equal(alice.user.role, 'user');
  assert.equal(alice.user.password, undefined);

  const stored = await User.findOne({ email: 'alice@test.io' }).select('+password').lean();
  assert.match(stored.password, /^\$2[aby]\$/, 'stored as a bcrypt hash');

  const escalate = await register('Mallory', 'mallory@test.io', { role: 'admin' });
  assert.equal(escalate.status, 201);
  assert.equal(escalate.body.user.role, 'user', 'registration cannot choose a role');

  assert.equal((await register('Dup', 'ALICE@test.io')).status, 409);
  assert.equal((await register('Short', 'short@test.io', { password: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'x@test.io', password: 'password123' } })).status, 400);
  assert.equal(
    (await call('POST', '/api/auth/login', { body: { email: 'alice@test.io', password: 'wrong-pass' } })).status,
    401
  );
  assert.equal(
    (await call('POST', '/api/auth/login', { body: { email: { $ne: null }, password: 'x' } })).status,
    400,
    'query operators in login are rejected'
  );

  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ role: 'user' }, process.env.JWT_SECRET, { subject: alice.user._id, expiresIn: -10 });
  assert.equal((await call('GET', '/api/auth/me', { token: expired })).status, 401);
  const forged = jwt.sign({ role: 'admin' }, 'wrong-secret', { subject: alice.user._id });
  assert.equal((await call('GET', '/api/auth/me', { token: forged })).status, 401);

  const me = await call('GET', '/api/auth/me', { token: alice.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'alice@test.io');
  assert.deepEqual(me.body.interests, ['chess', 'reading']);
  assert.ok(!me.raw.includes('password'));
});

test('notes: CRUD, ownership, pagination', async () => {
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const r = await call('POST', '/api/notes', { token: alice.token, body: { title: `A${i}`, userId: bob.user._id } });
    assert.equal(r.status, 201);
    assert.equal(r.body.userId, alice.user._id, 'userId comes from the token, not the body');
    ids.push(r.body._id);
  }
  await call('POST', '/api/notes', { token: bob.token, body: { title: 'B1' } });
  assert.equal((await call('POST', '/api/notes', { token: alice.token, body: { content: 'no title' } })).status, 400);
  assert.equal((await call('POST', '/api/notes', { body: { title: 'anon' } })).status, 401);

  const p1 = await call('GET', '/api/notes?limit=2', { token: alice.token });
  assert.deepEqual(p1.body.data.map((n) => n.title), ['A3', 'A2']);
  assert.deepEqual(p1.body.pagination, { page: 1, limit: 2, total: 3, totalPages: 2 });
  const p2 = await call('GET', '/api/notes?limit=2&page=2', { token: alice.token });
  assert.deepEqual(p2.body.data.map((n) => n.title), ['A1']);

  for (const bad of ['page=0', 'page=-1', 'limit=0', 'limit=abc', 'page=1.5']) {
    assert.equal((await call('GET', `/api/notes?${bad}`, { token: alice.token })).status, 400, bad);
  }
  assert.equal((await call('GET', '/api/notes?limit=1000', { token: alice.token })).body.pagination.limit, 100);

  const upd = await call('PUT', `/api/notes/${ids[0]}`, { token: alice.token, body: { title: 'A1 edited', userId: bob.user._id } });
  assert.equal(upd.body.title, 'A1 edited');
  assert.equal(upd.body.userId, alice.user._id, 'owner cannot be reassigned');
  assert.equal((await call('PUT', `/api/notes/${ids[0]}`, { token: alice.token, body: { title: '' } })).status, 400);

  // bob can't touch alice's note even if he knows the id
  assert.equal((await call('GET', `/api/notes/${ids[0]}`, { token: bob.token })).status, 404);
  assert.equal((await call('PUT', `/api/notes/${ids[0]}`, { token: bob.token, body: { title: 'x' } })).status, 404);
  assert.equal((await call('DELETE', `/api/notes/${ids[0]}`, { token: bob.token })).status, 404);
  const bobList = await call('GET', `/api/notes?userId=${alice.user._id}`, { token: bob.token });
  assert.deepEqual(bobList.body.data.map((n) => n.title), ['B1'], 'userId filter is ignored for non-admins');

  // admin can see all notes but can't edit someone else's
  const all = await call('GET', '/api/notes', { token: admin.token });
  assert.equal(all.body.pagination.total, 4);
  assert.equal(all.body.data[0].userId.name, 'Bob');
  const aliceOnly = await call('GET', `/api/notes?userId=${alice.user._id}`, { token: admin.token });
  assert.equal(aliceOnly.body.pagination.total, 3);
  assert.equal((await call('GET', `/api/notes/${ids[0]}`, { token: admin.token })).status, 200);
  assert.equal((await call('PUT', `/api/notes/${ids[0]}`, { token: admin.token, body: { title: 'x' } })).status, 404);
  assert.equal((await call('DELETE', `/api/notes/${ids[0]}`, { token: admin.token })).status, 404);

  assert.equal((await call('DELETE', `/api/notes/${ids[0]}`, { token: alice.token })).status, 204);
  assert.equal((await call('GET', `/api/notes/${ids[0]}`, { token: alice.token })).status, 404);
  assert.equal((await call('GET', '/api/notes/not-an-id', { token: alice.token })).status, 400);
});

test('posts: public feed, authenticated create', async () => {
  assert.equal((await call('POST', '/api/posts', { body: { title: 'anon' } })).status, 401);
  for (let i = 1; i <= 3; i++) {
    const r = await call('POST', '/api/posts', { token: bob.token, body: { title: `Bob post ${i}`, userId: alice.user._id } });
    assert.equal(r.body.userId, bob.user._id);
  }
  await call('POST', '/api/posts', { token: alice.token, body: { title: 'Alice post', content: 'hi' } });

  const feed = await call('GET', '/api/posts?limit=3'); // no token
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.pagination, { page: 1, limit: 3, total: 4, totalPages: 2 });
  assert.equal(feed.body.data[0].title, 'Alice post');
  assert.equal(feed.body.data[0].userId.name, 'Alice');
});

test('scenario 2: a user\'s posts in one aggregate() with $lookup', async () => {
  let res;
  const calls = await dbCallsDuring(async () => {
    res = await call('GET', `/api/users/${bob.user._id}/posts?limit=2`);
  });
  assert.deepEqual(calls, ['users.aggregate'], 'exactly one database call');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, { _id: bob.user._id, name: 'Bob' });
  assert.deepEqual(res.body.data.map((p) => p.title), ['Bob post 3', 'Bob post 2']);
  assert.deepEqual(res.body.pagination, { page: 1, limit: 2, total: 3, totalPages: 2 });

  const p2 = await call('GET', `/api/users/${bob.user._id}/posts?limit=2&page=2`);
  assert.deepEqual(p2.body.data.map((p) => p.title), ['Bob post 1']);

  const none = await call('GET', `/api/users/${carol.user._id}/posts`);
  assert.deepEqual(none.body.data, []);
  assert.equal(none.body.pagination.total, 0);

  const missingCalls = await dbCallsDuring(async () => {
    res = await call('GET', `/api/users/${new mongoose.Types.ObjectId()}/posts`);
  });
  assert.equal(res.status, 404);
  assert.deepEqual(missingCalls, ['users.aggregate'], 'unknown user needs no second query');
  assert.equal((await call('GET', '/api/users/not-an-id/posts')).status, 400);
});

test('scenario 1: users grouped by interest in one aggregate()', async () => {
  assert.equal((await call('GET', '/api/users/interests')).status, 401);

  let res;
  const calls = await dbCallsDuring(async () => {
    res = await call('GET', '/api/users/interests', { token: alice.token });
  });
  // the findOne is from the auth middleware, the grouping itself is a single aggregate
  assert.deepEqual(calls, ['users.findOne', 'users.aggregate']);

  const groups = Object.fromEntries(res.body.data.map((g) => [g.interest, g]));
  assert.deepEqual(Object.keys(groups), ['chess', 'coding', 'reading']);
  const names = (g) => g.users.map((u) => u.name).sort();
  assert.deepEqual(names(groups.chess), ['Alice', 'Carol']);
  assert.deepEqual(names(groups.reading), ['Alice', 'Bob']);
  assert.deepEqual(names(groups.coding), ['Bob']);
  assert.equal(groups.chess.count, 2);
  assert.deepEqual(res.body.pagination, { page: 1, limit: 20, total: 3, totalPages: 1 });
  assert.ok(!res.raw.includes('email'), 'does not expose emails');

  const p2 = await call('GET', '/api/users/interests?limit=2&page=2', { token: alice.token });
  assert.deepEqual(p2.body.data.map((g) => g.interest), ['reading']);
  assert.deepEqual(p2.body.pagination, { page: 2, limit: 2, total: 3, totalPages: 2 });
  const beyond = await call('GET', '/api/users/interests?page=9', { token: alice.token });
  assert.deepEqual(beyond.body.data, []);
  assert.equal(beyond.body.pagination.total, 3);
});

test('admin: user management and role checks', async () => {
  for (const [method, path] of [['GET', '/api/users'], ['POST', '/api/users'], ['GET', `/api/users/${bob.user._id}`],
    ['PUT', `/api/users/${bob.user._id}`], ['DELETE', `/api/users/${bob.user._id}`]]) {
    const body = method === 'POST' || method === 'PUT' ? {} : undefined;
    assert.equal((await call(method, path, { token: alice.token, body })).status, 403, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/api/users')).status, 401);

  const created = await call('POST', '/api/users', {
    token: admin.token,
    body: { name: 'Dave', email: 'dave@test.io', password: 'password123', role: 'admin', interests: ['Go'] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'admin');
  assert.equal(created.body.password, undefined);
  const bad = { name: 'X', email: 'x@test.io', password: 'password123' };
  assert.equal((await call('POST', '/api/users', { token: admin.token, body: { ...bad, role: 'root' } })).status, 400);
  assert.equal((await call('POST', '/api/users', { token: admin.token, body: { ...bad, email: 'nope' } })).status, 400);
  assert.equal((await call('POST', '/api/users', { token: admin.token, body: { ...bad, email: 'dave@test.io' } })).status, 409);

  const p1 = await call('GET', '/api/users?limit=2', { token: admin.token });
  assert.deepEqual(p1.body.data.map((u) => u.name), ['Dave', 'Mallory']);
  assert.deepEqual(p1.body.pagination, { page: 1, limit: 2, total: 6, totalPages: 3 });
  assert.ok(!p1.raw.includes('password'));

  assert.equal((await call('GET', `/api/users/${bob.user._id}`, { token: admin.token })).body.email, 'bob@test.io');
  assert.equal((await call('GET', `/api/users/${new mongoose.Types.ObjectId()}`, { token: admin.token })).status, 404);

  const upd = await call('PUT', `/api/users/${created.body._id}`, {
    token: admin.token,
    body: { role: 'user', password: 'newpassword1' },
  });
  assert.equal(upd.body.role, 'user');
  const relogin = await call('POST', '/api/auth/login', { body: { email: 'dave@test.io', password: 'newpassword1' } });
  assert.equal(relogin.status, 200, 'a password set by an admin is hashed and usable');

  // admin can't lock themselves out
  assert.equal((await call('PUT', `/api/users/${admin.user._id}`, { token: admin.token, body: { role: 'user' } })).status, 403);
  assert.equal((await call('DELETE', `/api/users/${admin.user._id}`, { token: admin.token })).status, 403);
  assert.equal((await call('PUT', `/api/users/${admin.user._id}`, { token: admin.token, body: { name: 'Root' } })).status, 200);

  // role change should apply right away, not when the token expires
  const dave = relogin.body;
  await call('PUT', `/api/users/${dave.user._id}`, { token: admin.token, body: { role: 'admin' } });
  assert.equal((await call('GET', '/api/users', { token: dave.token })).status, 200);
  await call('PUT', `/api/users/${dave.user._id}`, { token: admin.token, body: { role: 'user' } });
  assert.equal((await call('GET', '/api/users', { token: dave.token })).status, 403);

  // deleting bob removes his notes/posts and his token stops working
  assert.equal((await call('DELETE', `/api/users/${bob.user._id}`, { token: admin.token })).status, 204);
  assert.equal(await Note.countDocuments({ userId: bob.user._id }), 0);
  assert.equal(await Post.countDocuments({ userId: bob.user._id }), 0);
  assert.equal((await call('GET', '/api/auth/me', { token: bob.token })).status, 401);
  assert.equal((await call('DELETE', `/api/users/${bob.user._id}`, { token: admin.token })).status, 404);
});

test('query plans: every list/read query is served by an index', async () => {
  const userId = new mongoose.Types.ObjectId(alice.user._id);
  const page = { skip: 0, limit: 20 };
  const cases = [
    ['login', User.find({ email: 'alice@test.io' }), 'email_1'],
    ['user by id', User.find({ _id: userId }), '_id_'],
    ['admin list users', User.find().sort({ _id: -1 }).skip(0).limit(20), '_id_'],
    ['own notes', Note.find({ userId }).sort({ _id: -1 }).skip(0).limit(20), 'userId_1__id_-1'],
    // this is what countDocuments() runs under the hood
    ['own notes count', Note.aggregate([{ $match: { userId } }, { $group: { _id: 1, n: { $sum: 1 } } }]), 'userId_1__id_-1'],
    ['admin all notes', Note.find().sort({ _id: -1 }).skip(0).limit(20), '_id_'],
    ['note by id + owner', Note.find({ _id: new mongoose.Types.ObjectId(), userId }), '_id_'],
    ['posts feed', Post.find().sort({ _id: -1 }).skip(0).limit(20), '_id_'],
  ];
  for (const [name, query, index] of cases) {
    const p = plan(await query.explain('executionStats'));
    assert.ok(p.indexes.includes(index), `${name}: expected ${index}, got ${p.indexes}`);
    assert.ok(!p.stages.includes('COLLSCAN'), `${name}: collection scan`);
    assert.ok(!p.stages.includes('SORT'), `${name}: in-memory sort`);
  }

  const lookup = plan(await User.postsOf(userId, page).explain('executionStats'));
  assert.ok(lookup.indexes.includes('_id_'));
  assert.equal(lookup.lookups.length, 2);
  for (const l of lookup.lookups) {
    assert.deepEqual(l.indexesUsed, ['userId_1__id_-1']);
    assert.equal(l.collectionScans, 0);
  }
});

test('cors: only the configured frontend origin is allowed', async () => {
  const allowed = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { status: 'ok' });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const other = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);

  // browser preflight for an authenticated JSON request
  const preflight = await fetch(`${base}/api/notes`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
});
