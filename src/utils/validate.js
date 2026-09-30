const { Types } = require('mongoose');
const { HttpError } = require('../middleware/errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function objectId(value, name = 'id') {
  if (!Types.ObjectId.isValid(value)) throw new HttpError(400, `Invalid ${name}`);
  return new Types.ObjectId(String(value));
}

// only copy fields we allow, so stuff like role or userId can't be sent in the body
function pick(body, keys) {
  const out = {};
  for (const key of keys) if (body?.[key] !== undefined) out[key] = body[key];
  return out;
}

function password(value) {
  // bcrypt ignores anything after 72 bytes
  if (typeof value !== 'string' || value.length < 8 || value.length > 72) {
    throw new HttpError(400, 'password must be 8-72 characters');
  }
  return value;
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw new HttpError(400, `${name} must be a positive integer`);
  }
  return Number(value);
}

// page defaults to 1, limit to 20 (max 100)
function pagination(query) {
  const page = positiveInt(query.page, 'page', 1);
  const limit = Math.min(positiveInt(query.limit, 'limit', DEFAULT_LIMIT), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

function paginated(data, total, { page, limit }) {
  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

module.exports = { objectId, pick, password, pagination, paginated };
