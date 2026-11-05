# Photo Mosaic Wall 📸

A live photo wall for events, built to plug into an existing RSVP, registration, QR or lucky-draw system.

1. **Guests** register (name), open the camera and take a selfie, or pick a photo from the gallery.
2. **Admin** approves the photos (or turns on auto-approve). Each approved photo pops up big on the screen with the guest's name, then joins the wall.
3. **Admin presses a button** and every photo flies in from all over the screen to form a **letter, a name, a number, a shape** (heart, star, rings, crescent and more) or **your own logo**.

Even a small crowd can spell a long name: when a shape needs more tiles than there are photos, photos are reused. Arabic text works too (Cairo and Tajawal fonts, RTL guest page).

| Page | URL | Who |
|------|-----|-----|
| Guest page | `/?event=wedding` | guests (phone) |
| Big screen | `/screen?event=wedding` | projector / TV (press **F** for fullscreen) |
| Admin | `/admin?event=wedding` | you |

---

## Quick start (standalone)

```bash
npm install
```

```bash
MOSAIC_ADMIN_KEY=my-secret npm start
```

Open `http://localhost:3000/admin` and sign in with the key. Then open `http://localhost:3000/screen` on the big screen.

> **The camera needs HTTPS** on phones (browsers only allow `localhost` over plain http). In production, put the app behind your normal HTTPS reverse proxy (nginx, Caddy, Cloudflare and so on). For a quick test from a phone you can use a tunnel such as `cloudflared tunnel --url http://localhost:3000`. If the camera is blocked, guests can still pick a photo from their gallery.

See `.env.example` for all settings (`PORT`, `MOSAIC_ADMIN_KEY`, `MOSAIC_API_KEY`, `MOSAIC_DATA_DIR`, `BASE_PATH`, `MOSAIC_WEBHOOK_URL`, `MOSAIC_REDIRECT_ORIGINS`, …).

## Admin panel

- **Big screen modes:**
  - **Wall**: a tidy grid.
  - **Scatter**: a polaroid pile, good as the "before" look.
  - **Shape**: the photos fly into a shape.
- **Build a shape:**
  - **Text / Name / Number**: use `|` for a second line, e.g. `SARA|2026`.
  - **Shapes**: preset shapes.
  - **Logo / Image**: upload a PNG/JPG. Dark or opaque pixels become the shape; tick *Invert* if you need the opposite.
- **Detail** sets the minimum number of tiles. Higher gives sharper text; photos repeat to fill the tiles.
- **Live preview** shows exactly what the screen will show, using the real photos.
- **Quick replay** chips re-form shapes you used before, with one click. Use them to run a sequence live: `A` → `SARA` → ❤ → `2026`. Pressing *Form* again replays the fly-in with a new mix.
- **Moderation:** Pending / On screen / Hidden lists, *Approve all*, delete. New photos show up instantly.
- **Settings:**
  - auto-approve new photos
  - pop up new arrivals big on the screen
  - show a QR code on the screen (it can point to **your RSVP page** instead)
  - screen caption and background colour
- **Events:** type any event name in the top bar (`wedding`, `gala-2026`…). Each event has its own photos and screen.

---

## Integrate with your RSVP / registration / draw system

Pick whichever fits your system.

### A. Same Node/Express app: mount it (2 lines)

```js
const { createPhotoMosaic } = require('./photo-mosaic'); // copy this repo in, or npm install from git

const mosaic = createPhotoMosaic({ adminKey: process.env.MOSAIC_ADMIN_KEY });
app.use('/photo-wall', mosaic.router);   // pages + API under /photo-wall
mosaic.attach(io);                        // reuse your existing Socket.IO (uses the "/mosaic" namespace)
// no Socket.IO yet?  ->  mosaic.attach(httpServer, { basePath: '/photo-wall' })
```

All page URLs are relative, so any mount path works. A full runnable example is in [`examples/embed-in-existing-app.js`](examples/embed-in-existing-app.js).

From your own code you can also do:

```js
mosaic.events.on('photo:created', (photo) => { /* photo.ref = your guest id */ });
await mosaic.addPhoto({ event: 'wedding', name: 'Sara', ref: 'G-1001', image: dataUrl, status: 'approved' });
mosaic.formShape('wedding', { type: 'text', text: 'SARA' });
mosaic.formShape('wedding', { type: 'preset', preset: 'heart' });
mosaic.showWall('wedding');
mosaic.approvePhoto(id); mosaic.hidePhoto(id);
```

### B. Any other stack (PHP, Laravel, .NET, Python…): run it as a service

Run this app on its own (for example `photos.yourdomain.com`, or behind your proxy at `/photo-wall` with `BASE_PATH=/photo-wall`) and connect it in one of these ways.

**1. Link from your registration flow or QR code.** After a guest registers, send them to:

```
https://photos.yourdomain.com/?event=wedding&ref=GUEST_ID&name=Sara&skip=1&lang=ar&redirect=https://rsvp.yourdomain.com/thanks
```

| Param | Meaning |
|---|---|
| `event` | which wall/screen |
| `ref` | your guest id. If the same guest takes another photo, it replaces the old one |
| `name` | prefills the name |
| `skip=1` | skip the name step (when `name` is given) |
| `lang=ar` | Arabic UI (RTL) |
| `title` | custom heading |
| `redirect` | go back to your system afterwards. `?mosaic_photo=<id>` is added. Its origin must be listed in `MOSAIC_REDIRECT_ORIGINS` |

**2. Embed the guest page in an iframe** inside your registration page:

```html
<iframe src="https://photos.yourdomain.com/?event=wedding&ref=GUEST_ID&name=Sara&skip=1"
        allow="camera" style="width:100%;height:720px;border:0"></iframe>
<script>
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'mosaic:submitted') {
      // e.data = { event, ref, name, photo: { id, status } }
    }
  });
</script>
```

**3. Embed the big screen** inside your draw/event screen: `<iframe src="https://photos.yourdomain.com/screen?event=wedding" style="border:0;width:100vw;height:100vh">`.

**4. Server-to-server API.** If your system already takes the guest photo, push it here. Use the header `x-api-key` with the value of `MOSAIC_API_KEY` or `MOSAIC_ADMIN_KEY`.

```bash
curl -X POST https://photos.yourdomain.com/api/photos \
  -H "content-type: application/json" -H "x-api-key: $KEY" \
  -d '{"event":"wedding","name":"Sara","ref":"G-1001","status":"approved","image":"data:image/jpeg;base64,..."}'
```

**5. Webhook.** Set `MOSAIC_WEBHOOK_URL`. Every new photo is POSTed as `{ "type": "photo.created", "photo": {...} }`.

### HTTP API

Admin endpoints need the header `x-admin-key` (or `x-api-key`).

| Method | Path | |
|---|---|---|
| POST | `/api/photos` | upload `{event, name, ref, image}`. With a key you can also set `status` and `meta` |
| GET | `/api/events/:event/screen` | approved photos + display state (public) |
| GET | `/api/qr.svg?text=…` | QR code SVG |
| GET | `/api/admin/events` | list events with counts |
| GET | `/api/admin/events/:event` | photos, display, settings |
| PATCH | `/api/admin/photos/:id` | `{status: "approved" \| "hidden" \| "pending", name}` |
| DELETE | `/api/admin/photos/:id` | delete a photo |
| POST | `/api/admin/events/:event/approve-all` | approve every pending photo |
| DELETE | `/api/admin/events/:event/photos` | delete all photos of an event |
| PUT | `/api/admin/events/:event/display` | e.g. `{"mode":"shape","shape":{"type":"text","text":"SARA"}}`. Modes: `wall`, `scatter`, `shape`. Shape types: `text`, `preset`, `image` |
| PUT | `/api/admin/events/:event/settings` | `{autoApprove: true}` |

Realtime events are on the Socket.IO namespace `/mosaic`. Emit `join {event, role: 'screen' | 'admin', key}`. You then receive `photo:add`, `photo:remove`, `photo:upsert` (admin) and `display`.

## Hosting

| What | Where it works |
|---|---|
| **Demo page** (`demo/index.html`): one browser, live camera, sample guests, shapes | **Vercel** (or any static host). `vercel.json` already points Vercel at `demo/` |
| **Full system** (`server.js`): guest phones → admin → big screen | A host that keeps a Node server running with a disk: a VPS, Render, Railway, Fly.io, or inside your RSVP server |

Vercel cannot run the full system. It runs code as short-lived functions with a read-only disk, so `server.js` can't keep live connections to the big screen or save photos there. Deploying the full system to Vercel gives a `500 FUNCTION_INVOCATION_FAILED` error.

The camera only opens over **https** (or `localhost`). Vercel, Render and Railway all give you https automatically.

## Storage

Photos are saved as files in `data/uploads/`, and everything else goes in `data/db.json`. No database is needed. To store data in your system's own database instead, replace `src/store.js` with an implementation that has the same methods and pass it in with `createPhotoMosaic({ store })`.

## Project layout

```
server.js            standalone runner
src/index.js         createPhotoMosaic(): router, realtime, API
src/store.js         JSON file storage
public/capture.html  guest page          public/js/capture.js
public/screen.html   big screen (canvas) public/js/screen.js
public/admin.html    admin panel         public/js/admin.js
public/js/shapes.js  text/shape/logo → tile positions (shared by screen + admin preview)
demo/index.html      standalone demo for Vercel / static hosting (live camera, no server)
test/                API tests (npm test)
```
