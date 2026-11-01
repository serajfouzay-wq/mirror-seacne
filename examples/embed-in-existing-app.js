'use strict';
/**
 * Example: adding the photo wall to an EXISTING Express app (e.g. your RSVP /
 * registration / lucky-draw system). Run: node examples/embed-in-existing-app.js
 */
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createPhotoMosaic } = require('..'); // or require('photo-mosaic-wall') / './photo-mosaic'

const app = express();
const server = http.createServer(app);

// Your app probably already has Socket.IO for the draw screen. Reuse it:
const io = new Server(server);

// ---- your existing routes (RSVP, QR check-in, draw, ...) ----
app.get('/', (req, res) => res.send('<h1>My RSVP system</h1><a href="/register">Register</a>'));

// After a guest registers, send them to the selfie page with their id & name.
app.get('/register', (req, res) => {
  const guest = { id: 'G-1001', name: 'Sara' }; // ...from your database
  const selfie = `/photo-wall/?event=wedding&ref=${guest.id}&name=${encodeURIComponent(guest.name)}&skip=1&redirect=/thanks`;
  res.send(`<h1>Welcome ${guest.name}!</h1><a href="${selfie}">Take your selfie for the wall</a>`);
});
app.get('/thanks', (req, res) => res.send(`<h1>Thanks! Photo ${req.query.mosaic_photo} received.</h1>`));

// ---- the photo wall: two lines ----
const mosaic = createPhotoMosaic({ adminKey: process.env.MOSAIC_ADMIN_KEY || 'change-me', dataDir: __dirname + '/../data' });
app.use('/photo-wall', mosaic.router); // pages + API under /photo-wall
mosaic.attach(io); // live updates on the "/mosaic" namespace of your io

// Optional: react to new photos inside your own system (e.g. mark the guest as "photo taken").
mosaic.events.on('photo:created', (photo) => console.log('new photo from guest', photo.ref, photo.name));

// Optional: drive the big screen from your own admin / draw screen code.
//   mosaic.formShape('wedding', { type: 'text', text: 'S ♥ A' });
//   mosaic.formShape('wedding', { type: 'preset', preset: 'heart' });
//   mosaic.showWall('wedding');

server.listen(3000, () => console.log('http://localhost:3000  ·  wall: http://localhost:3000/photo-wall/admin'));
