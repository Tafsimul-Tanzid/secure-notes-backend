const express = require('express');
const cors = require('cors');
const config = require('./config');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const noteRoutes = require('./routes/notes');
const postRoutes = require('./routes/posts');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
// frontend is hosted separately, only its origin(s) are allowed. We use bearer
// tokens, not cookies, so no credentials option needed.
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '100kb' }));

// for the hosting platform's health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/posts', postRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
