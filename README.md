# Secure Notes API

Note-taking REST API with JWT auth and two roles (user and admin). It also has posts, plus the two MongoDB aggregation tasks from the assignment. The frontend is a separate repo (`notes_frontend`), a plain HTML/JS page for clicking through things.

Stack: Node.js (20.12+), Express 5, MongoDB (5.2+, I tested on 8.2), Mongoose 8, jsonwebtoken, bcryptjs, express-rate-limit.

## Setup

```bash
npm install
cp .env.example .env    # fill in JWT_SECRET and the SEED_ADMIN_* values
npm run seed            # creates the first admin
npm start               # http://localhost:3000
npm test                # uses a local secure_notes_test db (or TEST_MONGODB_URI)
```

You need MongoDB running locally for this, or point `MONGODB_URI` at an Atlas cluster.

Environment variables:

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/secure_notes` | |
| `JWT_SECRET` | none, required | any long random string, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `1h` | |
| `BCRYPT_ROUNDS` | `12` | |
| `PORT` | `3000` | |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | frontend URL(s) allowed to call the API, comma separated |
| `TRUST_PROXY` | `0` | set to `1` when hosted behind a proxy (Render etc.) so rate limiting sees the real client IP |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | name defaults to `Admin` | only used by `npm run seed` |

### Creating an admin

`npm run seed` creates an admin from the `SEED_ADMIN_*` variables. There are no hardcoded credentials, and if that email already exists it does nothing. After that, admins can create more users (including other admins) with `POST /api/users`. Normal registration always gives the `user` role.

### Indexes

`autoIndex` is turned off. On startup the app calls `syncIndexes()` for each model. That creates any missing indexes and drops any that are no longer declared in the schemas, so the database always matches the code.

## Deploying (Render + MongoDB Atlas)

Both have free tiers. This is what I used:

1. **Database:** create a free M0 cluster on [MongoDB Atlas](https://www.mongodb.com/atlas).
   - Add a database user.
   - Under Network Access, allow `0.0.0.0/0`. Render's free plan doesn't have fixed IPs.
   - Copy the connection string and put the database name in it, e.g. `mongodb+srv://user:pass@cluster0.xxxx.mongodb.net/secure_notes?retryWrites=true&w=majority`. Without a database name, Mongo uses one called `test`.
2. **Code:** push this repo to GitHub.
3. **Web service:** on [Render](https://render.com), go to New > Web Service and pick the repo.
   - Runtime: Node
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check path: `/api/health`
   - Environment variables: `MONGODB_URI` (the Atlas string), `JWT_SECRET` (a long random string), `TRUST_PROXY=1`, and `CORS_ORIGIN` (the frontend's URL, e.g. `https://notes-frontend.vercel.app`, no trailing slash). Render sets `PORT` itself.
4. **First admin:** run the seed once against the Atlas database from your own machine:
   ```bash
   MONGODB_URI="<atlas string>" JWT_SECRET=x SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='<strong password>' npm run seed
   ```
   `JWT_SECRET` only has to be set for the seed script to start. The value isn't used, so anything works.

The API is then live at `https://<your-service>.onrender.com/api`. `GET /api/health` should return `{"status":"ok"}`. Indexes are created automatically on the first start.

The frontend is deployed separately; see its README. If you deploy it after the backend, update `CORS_ORIGIN` on Render once you know its URL.

On the free plan the service goes to sleep after about 15 minutes without traffic. The first request after that takes around a minute while it wakes up.

## API

Authenticated routes need an `Authorization: Bearer <token>` header. Errors come back as `{ "error": "...", "details": [...] }`, where `details` is only present for validation errors.

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | anyone | `{ name, email, password, interests? }` returns `{ token, user }` |
| POST | `/api/auth/login` | anyone | `{ email, password }` returns `{ token, user }` |
| GET | `/api/auth/me` | logged in | your profile |
| POST | `/api/notes` | logged in | `{ title, content? }` |
| GET | `/api/notes` | logged in | users get their own notes. Admins get all notes, or `?userId=` for one user |
| GET | `/api/notes/:id` | logged in | own note, or any note for admins |
| PUT | `/api/notes/:id` | owner | `{ title?, content? }` |
| DELETE | `/api/notes/:id` | owner | |
| POST | `/api/users` | admin | `{ name, email, password, role?, interests? }` |
| GET | `/api/users` | admin | |
| GET | `/api/users/:id` | admin | |
| PUT | `/api/users/:id` | admin | any of `{ name, email, password, role, interests }` |
| DELETE | `/api/users/:id` | admin | also deletes that user's notes and posts |
| GET | `/api/users/interests` | logged in | aggregation scenario 1 |
| GET | `/api/users/:id/posts` | anyone | aggregation scenario 2 |
| POST | `/api/posts` | logged in | `{ title, content? }` |
| GET | `/api/posts` | anyone | |
| GET | `/api/health` | anyone | returns `{ "status": "ok" }`, used by Render's health check |

### Pagination

All list endpoints take `page` (default 1) and `limit` (default 20, max 100). Anything that isn't a positive integer returns 400. Lists are sorted newest first, and interest groups are sorted alphabetically.

```
GET /api/notes?page=2&limit=10

{ "data": [...], "pagination": { "page": 2, "limit": 10, "total": 34, "totalPages": 4 } }
```

```
GET /api/users/:id/posts?page=1&limit=5

{ "user": { "_id": "...", "name": "Bob" }, "data": [...], "pagination": { ... } }
```

## Auth and permissions

| | User | Admin |
|---|---|---|
| Create / list / read / update / delete own notes | yes | yes |
| Read other people's notes | no | yes (read only) |
| Manage users | no | yes |
| View own profile, write posts, see interest groups | yes | yes |

- Passwords are hashed with bcrypt in a `pre('save')` hook. When an admin changes a password it also goes through `save()`, so it gets hashed too. The password field is `select: false` and is also stripped in `toJSON`.
- Tokens are HS256, and verification only accepts HS256. A bad, missing or expired token gets a 401.
- The user is loaded from the database on every request, so deleting a user or changing their role applies straight away.
- Logout happens on the client, which just drops the token. Tokens are stateless, so it stays valid until `JWT_EXPIRES_IN`. Revoking tokens server-side would need a separate token store, which felt like overkill here.
- Note ownership is part of the query itself (`{ _id, userId }`), so someone else's note returns 404, the same as a note that doesn't exist.
- Request bodies are filtered through a list of allowed fields. You can't set `role` or `userId` yourself, and there's no endpoint for editing your own profile.
- Admins can't change their own role or delete their own account, so they can't lock themselves out.
- Login and register are rate limited. JSON bodies are capped at 100kb, and ids are checked before they're used in a query.
- CORS only allows the origins listed in `CORS_ORIGIN`. Auth uses a bearer token, not cookies, so no credentials are sent cross-site.

## Indexes

All indexes are defined with `schema.index()` in `src/models`. Apart from the default `_id` indexes there are three:

| Collection | Index | Used for |
|---|---|---|
| users | `{ email: 1 }` unique | login lookup, and keeping emails unique |
| notes | `{ userId: 1, _id: -1 }` | listing and counting a user's notes, and the delete when a user is removed |
| posts | `{ userId: 1, _id: -1 }` | the `$lookup` in scenario 2 (the page of posts and the count), and the delete when a user is removed |

Everything else uses the default `_id` index:

- getting, updating or deleting a single document
- loading the user from the token
- the admin user list, the admin all-notes list and the public post feed, which all sort by `_id`
- the `$match` in scenario 2

I sort by `_id` instead of `createdAt` because ObjectIds start with a timestamp, so the order is the same. That way those lists don't need a `createdAt` index. `_id` is also unique, so pages don't shift around when two things were created at the same time.

For lists without a filter, the total comes from `estimatedDocumentCount()`, which reads collection metadata instead of counting documents.

The compound indexes put `userId` first because that's the filter, and `_id` second because that's the sort. So Mongo reads a user's notes or posts already in order, and a count can come straight from the index without loading documents. With only `{ userId: 1 }`, the join would still work, but results would have to be sorted in memory.

I checked this with `explain()` on a user with 100 posts. Page 3 with `limit=10` read 30 index keys and 10 documents, and the count read 101 keys and 0 documents.

Things I didn't index:

- `createdAt`: not needed, since `_id` gives the same order
- `role`: nothing filters or sorts by it
- `interests`: explained in scenario 1 below

The tests check that the database has exactly these indexes. They also run `explain()` on the list and read queries to make sure none of them does a collection scan or an in-memory sort.

## Aggregations

Both pipelines are static methods on the User model (`src/models/User.js`). Each is a single `aggregate()` call. The tests confirm that by recording every database call made during the request.

### Scenario 1: users grouped by interest

`GET /api/users/interests`

```js
[
  { $unwind: '$interests' },
  { $group: { _id: '$interests', count: { $sum: 1 },
              users: { $firstN: { n: 50, input: { _id: '$_id', name: '$name' } } } } },
  { $sort: { _id: 1 } },
  { $facet: {
      data:  [{ $skip: skip }, { $limit: limit }, { $project: { _id: 0, interest: '$_id', count: 1, users: 1 } }],
      total: [{ $count: 'count' }],
  } },
]
```

`$facet` returns the page and the total number of groups in the same call. Each group lists at most 50 users, because the whole `$facet` result is one document and documents are capped at 16MB. `count` always shows the real total.

There's no index on `interests` on purpose. This pipeline has no filter, so every user has to be read to build the groups anyway. A multikey index can't cover the query, since `name` isn't in it, so Mongo would walk the whole index and still fetch every document. That's more work than a plain collection scan.

### Scenario 2: posts by one user

`GET /api/users/:id/posts`

```js
[
  { $match: { _id: userId } },
  { $lookup: { from: 'posts', localField: '_id', foreignField: 'userId',
               pipeline: [{ $sort: { _id: -1 } }, { $skip: skip }, { $limit: limit }, { $project: { __v: 0 } }],
               as: 'posts' } },
  { $lookup: { from: 'posts', localField: '_id', foreignField: 'userId',
               pipeline: [{ $count: 'count' }],
               as: 'total' } },
  { $project: { name: 1, posts: 1, total: { $ifNull: [{ $first: '$total.count' }, 0] } } },
]
```

- The `$match` uses the `_id` index.
- Both lookups join on `posts.userId` and use `{ userId: 1, _id: -1 }`. Explain shows `indexesUsed: ["userId_1__id_-1"]` and `collectionScans: 0`.
- The first lookup reads one page of posts from the index, already sorted.
- The count is a separate lookup so it can be answered from the index alone. Putting it in a `$facet` would load every post just to count them.
- If the user id doesn't exist, the pipeline returns an empty array and the route sends 404. No extra query is needed.

## Project structure

```
src/
  app.js, server.js, config.js, db.js
  models/        User (plus both aggregations), Note, Post
  routes/        auth, users, notes, posts
  middleware/    auth.js (JWT + role check), errors.js
  utils/         validate.js (ids, allowed fields, passwords, pagination)
scripts/seed.js  creates the first admin
test/            tests (node:test)
```
