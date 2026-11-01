'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { io: ioClient } = require('socket.io-client');
const { createPhotoMosaic } = require('../src');

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const KEY = 'test-key';

async function setup(basePath = '/mosaic') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-'));
  const app = express();
  const server = http.createServer(app);
  const mosaic = createPhotoMosaic({ dataDir, adminKey: KEY });
  app.use(basePath, mosaic.router);
  mosaic.attach(server, { basePath });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}${basePath}`;
  const req = async (p, { method = 'GET', body, key } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-admin-key'] = key;
    const res = await fetch(base + p, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, mosaic, base, req, port: server.address().port, basePath };
}

test('guest upload -> moderation -> screen, with realtime events', async () => {
  const { server, req, port, basePath } = await setup();
  try {
    const cfg = await req('/config.json');
    assert.equal(cfg.body.socketPath, '/mosaic/socket.io');

    const screen = ioClient(`http://localhost:${port}/mosaic`, { path: cfg.body.socketPath, transports: ['websocket'] });
    await new Promise((r) => screen.on('connect', r));
    await new Promise((r) => screen.emit('join', { event: 'party', role: 'screen' }, r));
    const added = new Promise((r) => screen.on('photo:add', r));

    const up = await req('/api/photos', { method: 'POST', body: { event: 'party', name: 'Sara', ref: 'G1', image: PNG } });
    assert.equal(up.status, 201);
    assert.equal(up.body.photo.status, 'pending');

    let s = await req('/api/events/party/screen');
    assert.equal(s.body.photos.length, 0, 'pending photos are not public');

    assert.equal((await req('/api/admin/events/party')).status, 401);
    const ev = await req('/api/admin/events/party', { key: KEY });
    assert.equal(ev.body.photos.length, 1);

    const id = up.body.photo.id;
    const patched = await req(`/api/admin/photos/${id}`, { method: 'PATCH', key: KEY, body: { status: 'approved' } });
    assert.equal(patched.body.photo.status, 'approved');
    const p = await added;
    assert.equal(p.id, id);
    assert.equal(p.name, 'Sara');

    s = await req('/api/events/party/screen');
    assert.equal(s.body.photos.length, 1);
    const img = await fetch(`http://localhost:${port}${basePath}/${s.body.photos[0].url}`);
    assert.equal(img.status, 200);

    // same ref replaces the old photo
    const up2 = await req('/api/photos', { method: 'POST', body: { event: 'party', name: 'Sara', ref: 'G1', image: PNG } });
    const all = await req('/api/admin/events/party', { key: KEY });
    assert.equal(all.body.photos.length, 1);
    assert.equal(all.body.photos[0].id, up2.body.photo.id);

    // display
    const displayEvt = new Promise((r) => screen.on('display', r));
    const d = await req('/api/admin/events/party/display', {
      method: 'PUT', key: KEY, body: { mode: 'shape', shape: { type: 'text', text: 'SARA' }, detail: 300 },
    });
    assert.equal(d.body.display.mode, 'shape');
    assert.equal(d.body.display.shape.text, 'SARA');
    assert.ok(d.body.display.layoutRev > 0);
    assert.equal((await displayEvt).shape.text, 'SARA');

    // caption change does not bump layoutRev
    const d2 = await req('/api/admin/events/party/display', { method: 'PUT', key: KEY, body: { caption: 'Hi' } });
    assert.equal(d2.body.display.layoutRev, d.body.display.layoutRev);

    assert.equal((await req('/api/admin/events/party/display', { method: 'PUT', key: KEY, body: { mode: 'nope' } })).status, 400);
    screen.close();
  } finally {
    server.close();
  }
});

test('API key can push approved photos (server-to-server) and bad images are rejected', async () => {
  const { server, req, mosaic } = await setup('/x');
  try {
    const created = [];
    mosaic.events.on('photo:created', (p) => created.push(p));
    const r = await req('/api/photos', { method: 'POST', key: KEY, body: { event: 'e1', name: 'Ali', image: PNG, status: 'approved', meta: { table: 4 } } });
    assert.equal(r.body.photo.status, 'approved');
    assert.deepEqual(r.body.photo.meta, { table: 4 });
    assert.equal(created.length, 1);

    const forged = await req('/api/photos', { method: 'POST', body: { event: 'e1', image: PNG, status: 'approved' } });
    assert.equal(forged.body.photo.status, 'pending', 'guests cannot self-approve');

    const bad = await req('/api/photos', { method: 'POST', body: { event: 'e1', image: 'data:text/html;base64,PGgxPg==' } });
    assert.equal(bad.status, 400);

    await req('/api/admin/events/e1/settings', { method: 'PUT', key: KEY, body: { autoApprove: true } });
    const auto = await req('/api/photos', { method: 'POST', body: { event: 'e1', image: PNG } });
    assert.equal(auto.body.photo.status, 'approved');

    const qr = await fetch(`http://localhost:${server.address().port}/x/api/qr.svg?text=hello`);
    assert.match(await qr.text(), /<svg/);
  } finally {
    server.close();
  }
});
