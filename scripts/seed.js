// Creates the first admin from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD
// (SEED_ADMIN_NAME is optional). Run with: npm run seed
const config = require('../src/config');
const db = require('../src/db');
const User = require('../src/models/User');
const { password } = require('../src/utils/validate');

async function main() {
  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: plain, SEED_ADMIN_NAME: name = 'Admin' } = process.env;
  if (!email || !plain) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD');
  password(plain);

  await db.connect(config.mongoUri);
  if (await User.exists({ email: email.trim().toLowerCase() })) {
    console.log(`${email} already exists; nothing to do.`);
  } else {
    await User.create({ name, email, password: plain, role: 'admin' });
    console.log(`Admin ${email} created.`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.disconnect());
