/* Big screen renderer.
 * Approved photos are drawn as tiles on a canvas. The admin switches the
 * arrangement (wall / scatter / shape); every tile then flies from wherever it
 * is to its new spot. Tiles are reused when a shape needs more tiles than there
 * are photos, so even 10 guests can spell a name. */
(function () {
  'use strict';
  const { params, cleanEvent, api, connect, url, loadFonts } = Mosaic;
  const SE = window.ShapeEngine;
  const $ = (id) => document.getElementById(id);

  const EVENT = cleanEvent(params.get('event'));
  loadFonts();

  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;

  let display = null;
  const photos = []; // active photos in arrival order: {id, name, url}
  const known = new Map(); // id -> photo (active, queued or loading)
  const thumbs = new Map(); // id -> canvas
  const sprites = new Map(); // key -> sprite
  const spawnFrom = new Map(); // id -> {x,y,s} start position for a newly added photo
  let layoutSeq = 0;
  let animUntil = 0;
  let lastLayoutRev = null;

  // ------------------------------------------------------------ helpers
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const rand = Math.random;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function makeThumb(img) {
    const size = known.size > 300 ? 128 : 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    roundRectPath(g, 0, 0, size, size, size * 0.1);
    g.clip();
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return c;
  }

  function loadThumb(p) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { thumbs.set(p.id, makeThumb(img)); resolve(true); };
      img.onerror = () => resolve(false);
      img.src = url(p.url);
    });
  }

  // ------------------------------------------------------------ layouts
  async function computeTargets() {
    const list = photos.filter((p) => thumbs.has(p.id));
    const n = list.length;
    const d = display;
    const targets = [];
    const seed = Math.floor((d.layoutRev || 1) % 2147483647);

    if (d.mode === 'shape') {
      const qrInset = d.showQr ? Math.min(220, W * 0.12) : 0;
      const AW = W - qrInset * 2;
      const want = Math.max(n, d.detail || 200);
      const { slots, size } = await SE.computeShapeSlots(d.shape, AW, H, want);
      const order = SE.shuffle(slots, SE.rng(seed));
      const s = Math.max(2, size - (d.gap || 0));
      order.forEach((slot, i) => {
        const x = slot.x + qrInset, y = slot.y;
        if (n && (i < n || d.repeat)) {
          const p = list[i % n];
          targets.push({ key: `${p.id}#${Math.floor(i / n)}`, id: p.id, x, y, s, rot: 0 });
        } else {
          targets.push({ key: `ph#${slot.r}:${slot.c}`, id: null, x, y, s, rot: 0 });
        }
      });
    } else if (d.mode === 'scatter') {
      const r = SE.rng(seed);
      const s = Math.max(50, Math.min(H * 0.28, Math.sqrt((W * H) / Math.max(n, 1)) * 0.85));
      list.forEach((p) => {
        targets.push({
          key: `${p.id}#0`, id: p.id, frame: true,
          x: s / 2 + r() * (W - s), y: s / 2 + r() * (H - s), s, rot: (r() - 0.5) * 0.7,
        });
      });
    } else {
      // wall: tidy grid of every photo once
      const { slots, size } = SE.gridSlots(n, W * 0.96, H * 0.94, H * 0.42);
      const gap = Math.max(d.gap || 0, size * 0.05);
      slots.forEach((slot, i) => {
        const p = list[i];
        targets.push({ key: `${p.id}#0`, id: p.id, x: slot.x + W * 0.02, y: slot.y + H * 0.03, s: size - gap, rot: 0 });
      });
    }
    return targets;
  }

  function stateAt(sp, now) {
    const p = sp.dur ? Math.max(0, Math.min(1, (now - sp.t0) / sp.dur)) : 1;
    const e = ease(p);
    const a = sp.from, b = sp.to, c = sp.ctrl;
    const u = 1 - e;
    return {
      x: u * u * a.x + 2 * u * e * c.x + e * e * b.x,
      y: u * u * a.y + 2 * u * e * c.y + e * e * b.y,
      s: a.s + (b.s - a.s) * e,
      rot: a.rot + (b.rot - a.rot) * e,
      alpha: a.alpha + (b.alpha - a.alpha) * Math.min(1, e * 2.5),
      frame: b.frame ? e : a.frame ? 1 - e : 0,
      done: p >= 1,
    };
  }

  function offscreenPoint() {
    const ang = rand() * Math.PI * 2;
    const r = Math.hypot(W, H) * (0.6 + rand() * 0.3);
    return { x: W / 2 + Math.cos(ang) * r, y: H / 2 + Math.sin(ang) * r };
  }

  function applyTargets(targets, style) {
    const now = performance.now();
    const fly = style === 'fly';
    const seen = new Set();
    const total = targets.length;

    targets.forEach((t) => {
      seen.add(t.key);
      let sp = sprites.get(t.key);
      const delay = fly ? rand() * Math.min(1600, 400 + total * 2) : rand() * 250;
      const dur = fly ? 1500 + rand() * 900 : 900;
      let from;
      if (sp) {
        const cur = stateAt(sp, now);
        from = { x: cur.x, y: cur.y, s: cur.s, rot: cur.rot, alpha: cur.alpha, frame: cur.frame > 0.5 };
      } else if (!t.id) {
        from = { x: t.x, y: t.y, s: 0, rot: 0, alpha: 0 };
      } else if (spawnFrom.has(t.id) && t.key.endsWith('#0')) {
        const sf = spawnFrom.get(t.id);
        spawnFrom.delete(t.id);
        from = { x: sf.x, y: sf.y, s: sf.s, rot: 0, alpha: 1 };
      } else {
        const o = offscreenPoint();
        from = { x: o.x, y: o.y, s: t.s * (0.6 + rand() * 1.6), rot: (rand() - 0.5) * 3, alpha: 1 };
      }
      if (!sp) {
        sp = { key: t.key, id: t.id };
        sprites.set(t.key, sp);
      }
      sp.dying = false;
      sp.from = from;
      sp.to = { x: t.x, y: t.y, s: t.s, rot: t.rot || 0, alpha: 1, frame: !!t.frame };
      const dx = t.x - from.x, dy = t.y - from.y;
      const bend = fly ? (rand() - 0.5) * 0.6 : 0;
      sp.ctrl = { x: (from.x + t.x) / 2 - dy * bend, y: (from.y + t.y) / 2 + dx * bend };
      sp.t0 = now + delay;
      sp.dur = dur;
      animUntil = Math.max(animUntil, sp.t0 + dur);
    });

    sprites.forEach((sp, key) => {
      if (seen.has(key) || sp.dying) return;
      const cur = stateAt(sp, now);
      sp.dying = true;
      sp.from = { x: cur.x, y: cur.y, s: cur.s, rot: cur.rot, alpha: cur.alpha };
      sp.to = { x: cur.x, y: cur.y, s: 0, rot: cur.rot, alpha: 0 };
      sp.ctrl = { x: cur.x, y: cur.y };
      sp.t0 = now;
      sp.dur = 500;
      animUntil = Math.max(animUntil, now + 500);
    });
  }

  let relayoutTimer = null;
  function scheduleRelayout(style = 'soft', wait = 80) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => relayout(style), wait);
  }

  async function relayout(style) {
    if (!display || !W) return;
    const seq = ++layoutSeq;
    const targets = await computeTargets();
    if (seq !== layoutSeq) return; // a newer layout started meanwhile
    applyTargets(targets, style);
    updateOverlays();
  }

  // ------------------------------------------------------------ render loop
  function frame(now) {
    requestAnimationFrame(frame);
    if (now > animUntil + 60 && !frame.dirty) return; // idle: nothing moves
    frame.dirty = false;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    sprites.forEach((sp, key) => {
      const st = stateAt(sp, now);
      if (sp.dying && st.done) { sprites.delete(key); return; }
      if (now < sp.t0 && !sp.wasDrawn && !sp.id) return;
      if (st.s < 0.5 || st.alpha <= 0.01) return;
      sp.wasDrawn = true;
      const half = st.s / 2;
      ctx.save();
      ctx.globalAlpha = st.alpha;
      ctx.translate(st.x, st.y);
      if (st.rot) ctx.rotate(st.rot);
      if (st.frame > 0.01) {
        // polaroid frame in scatter mode
        const b = st.s * 0.06 * st.frame;
        ctx.fillStyle = '#fff';
        ctx.shadowColor = 'rgba(0,0,0,.45)';
        ctx.shadowBlur = 12 * st.frame;
        ctx.fillRect(-half - b, -half - b, st.s + b * 2, st.s + b * 4);
        ctx.shadowBlur = 0;
      }
      const img = sp.id && thumbs.get(sp.id);
      if (img) {
        ctx.drawImage(img, -half, -half, st.s, st.s);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.13)';
        roundRectPath(ctx, -half, -half, st.s, st.s, st.s * 0.12);
        ctx.fill();
      }
      ctx.restore();
    });
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ spotlight for new arrivals
  const queue = [];
  let spotBusy = false;

  function enqueue(p) {
    if (display && display.spotlight) {
      queue.push(p);
      if (!spotBusy) nextSpot();
    } else {
      activate(p);
    }
  }

  function activate(p) {
    if (!known.has(p.id)) return; // removed meanwhile
    if (!photos.some((x) => x.id === p.id)) photos.push(p);
    scheduleRelayout('soft', 60);
  }

  async function nextSpot() {
    const p = queue.shift();
    if (!p) { spotBusy = false; return; }
    spotBusy = true;
    if (!known.has(p.id)) return nextSpot();
    const hold = queue.length > 8 ? 900 : queue.length > 2 ? 1800 : 3200;
    const el = $('spotlight');
    $('spotImg').src = url(p.url);
    $('spotName').textContent = p.name || '';
    el.classList.remove('hidden', 'out');
    void el.offsetWidth;
    el.classList.add('in');
    await new Promise((r) => setTimeout(r, hold));
    const rect = $('spotImg').getBoundingClientRect();
    spawnFrom.set(p.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, s: rect.width });
    el.classList.remove('in');
    el.classList.add('hidden');
    activate(p);
    setTimeout(nextSpot, 450);
  }

  // ------------------------------------------------------------ overlays
  function joinUrl() {
    return (display && display.qrUrl) || new URL(`./?event=${encodeURIComponent(EVENT)}`, Mosaic.BASE).href;
  }

  let lastQr = '';
  function updateOverlays() {
    if (!display) return;
    document.body.style.background = display.background || '#0b0b14';
    const target = joinUrl();
    if (target !== lastQr) {
      lastQr = target;
      const src = url('api/qr.svg?text=' + encodeURIComponent(target));
      $('qrImg').src = src;
      $('qrBig').src = src;
    }
    const nActive = photos.length;
    const empty = nActive === 0 && queue.length === 0 && !spotBusy && display.mode !== 'shape';
    $('emptyState').classList.toggle('hidden', !empty);
    $('emptyCaption').textContent = display.caption || '';
    $('qrBox').classList.toggle('hidden', !display.showQr || empty);
    $('qrCaption').textContent = display.caption || '';
    $('counter').textContent = nActive ? `${nActive} 📸` : '';
  }

  function applyDisplay(d, initial) {
    const prev = display;
    display = d;
    updateOverlays();
    if (initial || !prev || d.layoutRev !== lastLayoutRev) {
      lastLayoutRev = d.layoutRev;
      scheduleRelayout('fly', 0);
    }
  }

  // ------------------------------------------------------------ data sync
  function addPhoto(p, viaSpotlight) {
    if (known.has(p.id)) return;
    known.set(p.id, p);
    loadThumb(p).then((ok) => {
      if (!ok || !known.has(p.id)) return;
      if (viaSpotlight) enqueue(p);
      else activate(p);
    });
  }

  function removePhoto(id) {
    known.delete(id);
    thumbs.delete(id);
    const i = photos.findIndex((p) => p.id === id);
    if (i >= 0) photos.splice(i, 1);
    scheduleRelayout('soft', 60);
    updateOverlays();
  }

  let firstSync = true;
  async function sync() {
    try {
      const state = await api(`api/events/${EVENT}/screen`);
      const ids = new Set(state.photos.map((p) => p.id));
      [...known.keys()].forEach((id) => { if (!ids.has(id)) removePhoto(id); });
      if (firstSync) {
        // initial load: wait for all thumbnails, then fly everything in at once
        const fresh = state.photos.filter((p) => !known.has(p.id));
        fresh.forEach((p) => known.set(p.id, p));
        await Promise.all(fresh.map(loadThumb));
        fresh.forEach((p) => { if (thumbs.has(p.id)) photos.push(p); });
        firstSync = false;
        applyDisplay(state.display, true);
      } else {
        state.photos.forEach((p) => addPhoto(p, true));
        if (!display || state.display.rev !== display.rev) applyDisplay(state.display);
      }
    } catch (e) {
      console.warn('sync failed', e);
    }
  }

  function setConn(s) {
    $('conn').className = 'conn ' + s;
  }

  async function start() {
    resize();
    await sync();
    const socket = await connect({
      event: EVENT,
      role: 'screen',
      onJoin: () => { if (!firstSync) sync(); },
      onStatus: setConn,
    });
    if (socket) {
      socket.on('photo:add', (p) => addPhoto(p, true));
      socket.on('photo:remove', ({ id }) => removePhoto(id));
      socket.on('display', (d) => applyDisplay(d));
    } else {
      setConn('offline');
      setInterval(sync, 4000);
    }
  }

  // ------------------------------------------------------------ chrome
  window.addEventListener('resize', () => { resize(); frame.dirty = true; scheduleRelayout('soft', 150); });

  function toggleFs() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen && document.exitFullscreen();
  }
  $('fsBtn').onclick = toggleFs;
  window.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFs(); });
  let idleTimer;
  window.addEventListener('mousemove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  });

  start();
})();
