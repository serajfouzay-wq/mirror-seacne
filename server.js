'use strict';

/**
 * Standalone runner. To embed inside another app, see README.md ("Integrate").
 *   PORT=3000 MOSAIC_ADMIN_KEY=secret node server.js
 *   BASE_PATH=/mosaic  -> serve everything under /mosaic (same as when embedded)
 */

const http = require('http');
const express = require('express');
const { createPhotoMosaic } = require('./src');

const PORT = Number(process.env.PORT) || 3000;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

const mosaic = createPhotoMosaic();
app.use(BASE_PATH || '/', mosaic.router);
mosaic.attach(server, { basePath: BASE_PATH });

if (BASE_PATH) app.get('/', (req, res) => res.redirect(BASE_PATH + '/'));

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}${BASE_PATH}`;
  console.log(`Photo Mosaic running:
  Guest page : ${base}/
  Big screen : ${base}/screen
  Admin      : ${base}/admin`);
});

const shutdown = () => {
  mosaic.store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
