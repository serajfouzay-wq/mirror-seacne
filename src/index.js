'use strict';

/**
 * Photo Mosaic Wall — embeddable module.
 *
 *   const { createPhotoMosaic } = require('./photo-mosaic');   // or this package
 *   const mosaic = createPhotoMosaic({ adminKey: 'secret' });
 *   app.use('/mosaic', mosaic.router);                            // pages + API
 *   mosaic.attach(httpServer, { basePath: '/mosaic' });           // live updates
 *     // ...or, if your app already has Socket.IO:  mosaic.attach(io)
 *
 * Pages (relative to the mount point):
 *   /            guest page: name + camera selfie   (?event=&name=&ref=&lang=ar&redirect=)
 *   /screen      big screen                        (?event=)
 *   /admin       control panel                     (?event=)
 */

const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');
const QRCode = require('qrcode');
const { Store } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const NAMESPACE = '/mosaic';
const ALLOWED_IMAGE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function cleanEvent(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : 'main';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function publicPhoto(p) {
  return { id: p.id, name: p.name, url: `uploads/${p.file}`, createdAt: p.createdAt };
}

function adminPhoto(p) {
  return Object.assign(publicPhoto(p), { status: p.status, ref: p.ref, event: p.event, meta: p.meta });
}

function parseDataUrl(dataUrl, maxBytes) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m || !ALLOWED_IMAGE[m[1]]) throw httpError(400, 'image must be a JPEG/PNG/WebP data URL');
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw httpError(400, 'empty image');
  if (buffer.length > maxBytes) throw httpError(413, 'image too large');
  return { buffer, ext: ALLOWED_IMAGE[m[1]] };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function createPhotoMosaic(options = {}) {
  const opts = Object.assign(
    {
      dataDir: process.env.MOSAIC_DATA_DIR || path.join(process.cwd(), 'data'),
      adminKey: process.env.MOSAIC_ADMIN_KEY || 'admin',
      apiKey: process.env.MOSAIC_API_KEY || null, // server-to-server key; falls back to adminKey
      webhookUrl: process.env.MOSAIC_WEBHOOK_URL || null,
      redirectOrigins: (process.env.MOSAIC_REDIRECT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
      maxUploadMB: Number(process.env.MOSAIC_MAX_UPLOAD_MB) || 6,
      title: process.env.MOSAIC_TITLE || 'Photo Wall',
    },
    options
  );
  if (opts.adminKey === 'admin') {
    console.warn('[mosaic] WARNING: using default admin key "admin". Set MOSAIC_ADMIN_KEY in production.');
  }

  const store = options.store || new Store(opts.dataDir);
  const events = new EventEmitter();
  let nsp = null; // socket.io namespace once attached
  let socketPath = '/socket.io';

  const isAdminKey = (k) => safeEqual(k, opts.adminKey) || (opts.apiKey && safeEqual(k, opts.apiKey));

  // ---------------------------------------------------------------- realtime
  function emitPhotoChange(photo, prevStatus) {
    if (!nsp) return;
    const ev = photo.event;
    nsp.to(`admin:${ev}`).emit('photo:upsert', adminPhoto(photo));
    if (photo.status === 'approved' && prevStatus !== 'approved') {
      nsp.to(`screen:${ev}`).emit('photo:add', publicPhoto(photo));
    } else if (photo.status !== 'approved' && prevStatus === 'approved') {
      nsp.to(`screen:${ev}`).emit('photo:remove', { id: photo.id });
    }
  }

  function emitPhotoRemoved(photo) {
    if (!nsp) return;
    nsp.to(`admin:${photo.event}`).emit('photo:remove', { id: photo.id });
    nsp.to(`screen:${photo.event}`).emit('photo:remove', { id: photo.id });
  }

  function emitDisplay(event, display) {
    if (!nsp) return;
    nsp.to(`screen:${event}`).emit('display', display);
    nsp.to(`admin:${event}`).emit('display', display);
  }

  function attach(serverOrIo, attachOpts = {}) {
    let io = serverOrIo;
    if (!serverOrIo || typeof serverOrIo.of !== 'function') {
      // An http.Server was passed: create our own Socket.IO on a path under the mount point.
      const { Server } = require('socket.io');
      const base = (attachOpts.basePath || '').replace(/\/+$/, '');
      socketPath = `${base}/socket.io`;
      io = new Server(serverOrIo, { path: socketPath, maxHttpBufferSize: 1e6 });
    } else if (serverOrIo._path) {
      socketPath = serverOrIo._path; // existing io instance: reuse its path
    }
    nsp = io.of(NAMESPACE);
    nsp.on('connection', (socket) => {
      socket.on('join', (msg = {}, ack) => {
        const ev = cleanEvent(msg.event);
        if (msg.role === 'admin') {
          if (!isAdminKey(msg.key)) return typeof ack === 'function' && ack({ ok: false, error: 'bad key' });
          socket.join(`admin:${ev}`);
        } else {
          socket.join(`screen:${ev}`);
        }
        if (typeof ack === 'function') ack({ ok: true });
      });
    });
    return io;
  }

  // ------------------------------------------------------------- core actions
  async function addPhoto({ event, name, ref, image, buffer, ext, status, meta }) {
    const ev = cleanEvent(event);
    if (!buffer) ({ buffer, ext } = parseDataUrl(image, opts.maxUploadMB * 1024 * 1024));
    const settings = store.getSettings(ev);
    const finalStatus = status || (settings.autoApprove ? 'approved' : 'pending');
    const { photo, replaced } = store.addPhoto({ event: ev, name, ref, buffer, ext, status: finalStatus, meta });
    if (replaced) emitPhotoRemoved(replaced);
    emitPhotoChange(photo, null);
    events.emit('photo:created', adminPhoto(photo));
    if (opts.webhookUrl) {
      fetch(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'photo.created', photo: adminPhoto(photo) }),
      }).catch((e) => console.error('[mosaic] webhook failed:', e.message));
    }
    return photo;
  }

  function setPhotoStatus(id, status) {
    const before = store.getPhoto(id);
    if (!before) return null;
    const prev = before.status;
    const p = store.updatePhoto(id, { status });
    emitPhotoChange(p, prev);
    events.emit('photo:updated', adminPhoto(p));
    return p;
  }

  function setDisplay(event, patch) {
    const ev = cleanEvent(event);
    const d = store.setDisplay(ev, patch);
    emitDisplay(ev, d);
    return d;
  }

  // ------------------------------------------------------------------ router
  const router = express.Router();
  const json = express.json({ limit: `${Math.ceil(opts.maxUploadMB * 1.4) + 1}mb` });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const requireAdmin = (req, res, next) => {
    const key = req.get('x-admin-key') || req.get('x-api-key') || req.query.key;
    if (!isAdminKey(key)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  // Pages. Relative URLs are used everywhere so the module works under any mount path.
  const page = (file) => (req, res) => {
    if (file === 'capture.html' && !req.originalUrl.split('?')[0].endsWith('/')) {
      const [p, q] = req.originalUrl.split('?');
      return res.redirect(p + '/' + (q ? '?' + q : ''));
    }
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
  router.get('/', page('capture.html'));
  router.get('/screen', page('screen.html'));
  router.get('/admin', page('admin.html'));
  router.use('/static', express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
  // socket.io's package "exports" hides client-dist, so resolve it from the package root
  const SOCKET_CLIENT = path.join(path.dirname(require.resolve('socket.io')), '..', 'client-dist', 'socket.io.min.js');
  router.get('/vendor/socket.io.min.js', (req, res) => res.sendFile(SOCKET_CLIENT, { maxAge: '1d' }));
  router.use('/uploads', express.static(store.uploadDir, { index: false, maxAge: '7d', immutable: true }));

  router.get('/config.json', (req, res) => {
    res.json({
      title: opts.title,
      socketPath,
      namespace: NAMESPACE,
      realtime: !!nsp,
      redirectOrigins: opts.redirectOrigins,
    });
  });

  router.get('/api/qr.svg', wrap(async (req, res) => {
    const text = String(req.query.text || '').slice(0, 600);
    if (!text) return res.status(400).end();
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('cache-control', 'public, max-age=3600').send(svg);
  }));

  router.get('/api/events/:event/screen', (req, res) => {
    const ev = cleanEvent(req.params.event);
    res.json({ photos: store.listPhotos(ev, 'approved').map(publicPhoto), display: store.getDisplay(ev) });
  });

  // Guest upload (public). With an admin/API key you may also force `status`.
  router.post('/api/photos', json, wrap(async (req, res) => {
    const b = req.body || {};
    const key = req.get('x-api-key') || req.get('x-admin-key');
    const trusted = key && isAdminKey(key);
    const status = trusted && ['pending', 'approved', 'hidden'].includes(b.status) ? b.status : undefined;
    const photo = await addPhoto({
      event: b.event,
      name: b.name,
      ref: b.ref,
      image: b.image,
      status,
      meta: trusted && b.meta && typeof b.meta === 'object' ? b.meta : null,
    });
    res.status(201).json({ photo: trusted ? adminPhoto(photo) : { id: photo.id, status: photo.status } });
  }));

  // ---- admin API
  router.get('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));
  router.get('/api/admin/events', requireAdmin, (req, res) => res.json({ events: store.listEvents() }));

  router.get('/api/admin/events/:event', requireAdmin, (req, res) => {
    const ev = cleanEvent(req.params.event);
    res.json({
      event: ev,
      photos: store.listPhotos(ev).map(adminPhoto),
      display: store.getDisplay(ev),
      settings: store.getSettings(ev),
    });
  });

  router.patch('/api/admin/photos/:id', requireAdmin, json, (req, res) => {
    const b = req.body || {};
    let p = store.getPhoto(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (typeof b.name === 'string') {
      p = store.updatePhoto(p.id, { name: b.name });
      if (nsp) nsp.to(`admin:${p.event}`).emit('photo:upsert', adminPhoto(p));
    }
    if (b.status) p = setPhotoStatus(p.id, b.status);
    res.json({ photo: adminPhoto(p) });
  });

  router.delete('/api/admin/photos/:id', requireAdmin, (req, res) => {
    const p = store.deletePhoto(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    emitPhotoRemoved(p);
    events.emit('photo:deleted', adminPhoto(p));
    res.json({ ok: true });
  });

  router.post('/api/admin/events/:event/approve-all', requireAdmin, (req, res) => {
    const ev = cleanEvent(req.params.event);
    const pending = store.listPhotos(ev, 'pending');
    pending.forEach((p) => setPhotoStatus(p.id, 'approved'));
    res.json({ approved: pending.length });
  });

  router.delete('/api/admin/events/:event/photos', requireAdmin, (req, res) => {
    const ev = cleanEvent(req.params.event);
    const removed = store.clearEvent(ev);
    removed.forEach(emitPhotoRemoved);
    res.json({ removed: removed.length });
  });

  router.put('/api/admin/events/:event/display', requireAdmin, json, (req, res) => {
    const b = req.body || {};
    const allowed = ['mode', 'shape', 'detail', 'gap', 'repeat', 'background', 'showQr', 'caption', 'spotlight', 'qrUrl'];
    const patch = {};
    for (const k of allowed) if (k in b) patch[k] = b[k];
    if (patch.mode && !['wall', 'scatter', 'shape'].includes(patch.mode)) return res.status(400).json({ error: 'bad mode' });
    if (patch.shape) {
      const s = patch.shape;
      const clean = {};
      if (['text', 'preset', 'image'].includes(s.type)) clean.type = s.type;
      if (typeof s.text === 'string') clean.text = s.text.slice(0, 60);
      if (typeof s.font === 'string') clean.font = s.font.slice(0, 40);
      if (typeof s.preset === 'string') clean.preset = s.preset.slice(0, 30);
      if ('invert' in s) clean.invert = !!s.invert;
      if (s.image === null || (typeof s.image === 'string' && s.image.startsWith('data:image/') && s.image.length < 1.5e6)) {
        clean.image = s.image;
      }
      patch.shape = clean;
    }
    if ('detail' in patch) patch.detail = Math.max(20, Math.min(3000, Number(patch.detail) || 220));
    if ('gap' in patch) patch.gap = Math.max(0, Math.min(20, Number(patch.gap) || 0));
    if ('caption' in patch) patch.caption = String(patch.caption).slice(0, 140);
    if ('qrUrl' in patch) patch.qrUrl = /^https?:\/\//i.test(patch.qrUrl) ? String(patch.qrUrl).slice(0, 500) : '';
    for (const k of ['repeat', 'showQr', 'spotlight']) if (k in patch) patch[k] = !!patch[k];
    if ('background' in patch && !/^#[0-9a-f]{3,8}$/i.test(patch.background)) delete patch.background;
    res.json({ display: setDisplay(req.params.event, patch) });
  });

  router.put('/api/admin/events/:event/settings', requireAdmin, json, (req, res) => {
    const b = req.body || {};
    const patch = {};
    if ('autoApprove' in b) patch.autoApprove = !!b.autoApprove;
    res.json({ settings: store.setSettings(cleanEvent(req.params.event), patch) });
  });

  // JSON errors
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('[mosaic]', err);
    res.status(status).json({ error: status >= 500 ? 'server error' : err.message });
  });

  return {
    router,
    attach,
    store,
    events, // EventEmitter: 'photo:created' | 'photo:updated' | 'photo:deleted'
    // Programmatic API for host apps (e.g. your RSVP system's own registration flow)
    addPhoto,
    approvePhoto: (id) => setPhotoStatus(id, 'approved'),
    hidePhoto: (id) => setPhotoStatus(id, 'hidden'),
    setDisplay,
    formShape: (event, shape, extra = {}) => setDisplay(event, Object.assign({}, extra, { mode: 'shape', shape })),
    showWall: (event) => setDisplay(event, { mode: 'wall' }),
  };
}

module.exports = { createPhotoMosaic, cleanEvent };
