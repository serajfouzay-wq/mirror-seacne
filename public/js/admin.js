/* Admin panel: moderation + big-screen control. */
(function () {
  'use strict';
  const { params, cleanEvent, api, connect, url, loadFonts, escapeHtml } = Mosaic;
  const SE = window.ShapeEngine;
  const $ = (id) => document.getElementById(id);
  loadFonts();

  let KEY = '';
  try { KEY = localStorage.getItem('mosaic:adminKey') || ''; } catch (_) {}
  let EVENT = cleanEvent(params.get('event') || (localStorage.getItem('mosaic:event') || 'main'));

  let photos = new Map(); // id -> photo
  let display = null;
  let settings = null;
  let filter = 'pending';
  let socket = null;
  // draft shape being edited (sent to the screen only on "Form")
  let draft = { type: 'text', text: 'HELLO', font: 'Anton', preset: 'heart', image: null, invert: false };
  let draftDetail = 220, draftGap = 2, draftRepeat = true;

  const call = (path, opts = {}) => api(path, Object.assign({ key: KEY }, opts));

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  // ------------------------------------------------------------ auth
  async function tryLogin(key) {
    try {
      await api('api/admin/check', { key });
      return true;
    } catch (_) {
      return false;
    }
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = $('keyInput').value;
    if (await tryLogin(k)) {
      KEY = k;
      try { localStorage.setItem('mosaic:adminKey', k); } catch (_) {}
      boot();
    } else {
      $('loginError').classList.remove('hidden');
    }
  });

  $('logout').onclick = () => {
    try { localStorage.removeItem('mosaic:adminKey'); } catch (_) {}
    location.reload();
  };

  // ------------------------------------------------------------ event
  async function loadEvent() {
    try { localStorage.setItem('mosaic:event', EVENT); } catch (_) {}
    $('eventInput').value = EVENT;
    const u = new URL(location.href);
    u.searchParams.set('event', EVENT);
    history.replaceState(null, '', u);

    const data = await call(`api/admin/events/${EVENT}`);
    photos = new Map(data.photos.map((p) => [p.id, p]));
    display = data.display;
    settings = data.settings;
    draft = Object.assign({}, display.shape);
    draftDetail = display.detail;
    draftGap = display.gap;
    draftRepeat = display.repeat;
    if (![...photos.values()].some((p) => p.status === 'pending')) filter = 'approved';
    fillShapeForm();
    fillSettings();
    renderMode();
    renderPhotos();
    renderLinks();
    refreshEventList();
    if (socket) socket.disconnect();
    socket = await connect({
      event: EVENT,
      role: 'admin',
      key: KEY,
      onStatus: (s) => { $('connPill').textContent = s; $('connPill').className = 'conn-pill ' + s; },
    });
    if (socket) {
      socket.on('photo:upsert', (p) => {
        const isNew = !photos.has(p.id);
        photos.set(p.id, p);
        renderPhotos();
        if (isNew && p.status === 'pending') toast(`New photo from ${p.name || 'a guest'}`);
      });
      socket.on('photo:remove', ({ id }) => { photos.delete(id); renderPhotos(); });
      socket.on('display', (d) => { display = d; renderMode(); });
    }
  }

  async function refreshEventList() {
    try {
      const { events } = await call('api/admin/events');
      $('eventList').innerHTML = events.map((e) => `<option value="${escapeHtml(e.event)}">${e.total} photos</option>`).join('');
    } catch (_) {}
  }

  $('eventInput').addEventListener('change', () => {
    const v = cleanEvent($('eventInput').value);
    if (v !== EVENT) { EVENT = v; loadEvent(); }
  });

  function renderLinks() {
    const guest = new URL(`./?event=${encodeURIComponent(EVENT)}`, Mosaic.BASE).href;
    const screen = new URL(`screen?event=${encodeURIComponent(EVENT)}`, Mosaic.BASE).href;
    $('guestLink').textContent = guest;
    $('screenLink').textContent = screen;
    $('openGuest').href = guest;
    $('openScreen').href = screen;
    $('guestQr').src = url('api/qr.svg?text=' + encodeURIComponent((display && display.qrUrl) || guest));
  }
  document.querySelectorAll('.copy').forEach((el) =>
    el.addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(el.textContent).then(() => toast('Copied'));
    })
  );

  // ------------------------------------------------------------ screen mode
  async function setDisplay(patch, msg) {
    try {
      const r = await call(`api/admin/events/${EVENT}/display`, { method: 'PUT', body: patch });
      display = r.display;
      renderMode();
      if (msg) toast(msg);
    } catch (e) {
      toast('Error: ' + e.message);
    }
  }

  function describeShape(s) {
    if (s.type === 'preset') return (SE.PRESETS[s.preset] || {}).label || s.preset;
    if (s.type === 'image') return 'logo image';
    return `“${s.text}”`;
  }

  function renderMode() {
    if (!display) return;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === display.mode));
    $('modeInfo').textContent =
      display.mode === 'shape' ? `Screen is showing ${describeShape(display.shape)}.`
        : display.mode === 'scatter' ? 'Photos are scattered like polaroids. Press a shape when ready!'
          : 'Photos are on a tidy wall.';
  }

  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.mode;
      if (mode === 'shape') return formShape();
      setDisplay({ mode });
    })
  );

  // ------------------------------------------------------------ shape builder
  $('shapeFont').innerHTML = SE.FONTS.map((f) => `<option value="${f.id}" style="font-family:${escapeHtml(f.css)}">${f.id}</option>`).join('');
  $('presetGrid').innerHTML = Object.entries(SE.PRESETS)
    .map(([id, p]) => `<button type="button" class="preset" data-preset="${id}" title="${p.label}"><canvas width="64" height="64"></canvas><span>${p.label}</span></button>`)
    .join('');
  document.querySelectorAll('.preset').forEach(async (btn) => {
    const c = btn.querySelector('canvas');
    const m = await SE.renderMask({ type: 'preset', preset: btn.dataset.preset }, 64, 64);
    const g = c.getContext('2d');
    g.drawImage(m, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#ff5fa2';
    g.fillRect(0, 0, 64, 64);
    btn.onclick = () => { draft.type = 'preset'; draft.preset = btn.dataset.preset; fillShapeForm(); };
  });

  function fillShapeForm() {
    document.querySelectorAll('#shapeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === draft.type));
    document.querySelectorAll('.tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.for !== draft.type));
    document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === draft.preset));
    $('shapeText').value = draft.text || '';
    $('shapeFont').value = draft.font || 'Anton';
    $('shapeInvert').checked = !!draft.invert;
    $('detail').value = draftDetail;
    $('detailVal').textContent = draftDetail;
    $('gap').value = draftGap;
    $('gapVal').textContent = draftGap;
    $('repeat').checked = draftRepeat;
    schedulePreview();
  }

  document.querySelectorAll('#shapeTabs button').forEach((b) =>
    b.addEventListener('click', () => { draft.type = b.dataset.type; fillShapeForm(); })
  );
  $('shapeText').addEventListener('input', () => { draft.text = $('shapeText').value; schedulePreview(); });
  $('shapeText').addEventListener('keydown', (e) => { if (e.key === 'Enter') formShape(); });
  $('shapeFont').addEventListener('change', () => { draft.font = $('shapeFont').value; schedulePreview(); });
  $('shapeInvert').addEventListener('change', () => { draft.invert = $('shapeInvert').checked; schedulePreview(); });
  $('detail').addEventListener('input', () => { draftDetail = +$('detail').value; $('detailVal').textContent = draftDetail; schedulePreview(); });
  $('gap').addEventListener('input', () => { draftGap = +$('gap').value; $('gapVal').textContent = draftGap; schedulePreview(); });
  $('repeat').addEventListener('change', () => { draftRepeat = $('repeat').checked; schedulePreview(); });

  $('shapeImage').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const img = new Image();
    const u = URL.createObjectURL(f);
    img.onload = () => {
      // downscale so the mask stays small when broadcast to screens
      const k = Math.min(1, 600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      draft.image = c.toDataURL('image/png');
      draft.type = 'image';
      URL.revokeObjectURL(u);
      fillShapeForm();
    };
    img.src = u;
  });

  // live preview (same engine as the screen, 16:9)
  const pv = $('preview');
  const pctx = pv.getContext('2d');
  const thumbImgs = new Map();
  function thumbImg(p) {
    if (!thumbImgs.has(p.id)) {
      const im = new Image();
      im.onload = schedulePreview;
      im.src = url(p.url);
      thumbImgs.set(p.id, im);
    }
    return thumbImgs.get(p.id);
  }
  let pvTimer;
  function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(drawPreview, 120); }
  async function drawPreview() {
    const PW = 1280, PH = 720, k = pv.width / PW;
    const approved = [...photos.values()].filter((p) => p.status === 'approved');
    const n = approved.length;
    const want = Math.max(n, draftDetail);
    let res;
    try {
      res = await SE.computeShapeSlots(draft, PW, PH, want);
    } catch (e) {
      return;
    }
    pctx.fillStyle = (display && display.background) || '#0b0b14';
    pctx.fillRect(0, 0, pv.width, pv.height);
    const s = Math.max(1, (res.size - draftGap) * k);
    res.slots.forEach((slot, i) => {
      const x = slot.x * k - s / 2, y = slot.y * k - s / 2;
      const p = n && (i < n || draftRepeat) ? approved[i % n] : null;
      const im = p && thumbImg(p);
      if (im && im.complete && im.naturalWidth) pctx.drawImage(im, x, y, s, s);
      else { pctx.fillStyle = p ? '#ff5fa2' : 'rgba(255,255,255,.18)'; pctx.fillRect(x, y, s, s); }
    });
    const tiles = res.slots.length;
    const reuse = n ? (tiles / n).toFixed(1) : '–';
    $('previewInfo').textContent = `${tiles} tiles · ${n} photos on screen` + (n && draftRepeat && tiles > n ? ` · each photo used ~${reuse}×` : '');
  }

  async function formShape(shape) {
    const s = shape || draft;
    if (s.type === 'text' && !String(s.text || '').trim()) return toast('Type some text first');
    if (s.type === 'image' && !s.image) return toast('Upload an image first');
    await setDisplay({ mode: 'shape', shape: s, detail: draftDetail, gap: draftGap, repeat: draftRepeat }, `Forming ${describeShape(s)} ✨`);
    rememberShape(s);
  }
  $('formShape').onclick = () => formShape();

  // recent shapes as one-click chips (great for running a sequence live)
  function recent() {
    try { return JSON.parse(localStorage.getItem('mosaic:recent') || '[]'); } catch (_) { return []; }
  }
  function rememberShape(s) {
    if (s.type === 'image') return; // too big to keep
    const key = JSON.stringify([s.type, s.text, s.font, s.preset]);
    const list = recent().filter((x) => JSON.stringify([x.type, x.text, x.font, x.preset]) !== key);
    list.unshift({ type: s.type, text: s.text, font: s.font, preset: s.preset });
    try { localStorage.setItem('mosaic:recent', JSON.stringify(list.slice(0, 12))); } catch (_) {}
    renderRecent();
  }
  function renderRecent() {
    const list = recent();
    $('recentShapes').innerHTML = list.length
      ? '<span class="muted small">Quick replay:</span>' + list.map((s, i) => `<button type="button" class="chip" data-i="${i}">${escapeHtml(describeShape(s))}</button>`).join('')
      : '';
    $('recentShapes').querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => {
        const s = recent()[+c.dataset.i];
        draft = Object.assign({}, draft, s);
        fillShapeForm();
        formShape(draft);
      })
    );
  }
  renderRecent();

  // ------------------------------------------------------------ photos
  document.querySelectorAll('#filterTabs button').forEach((b) =>
    b.addEventListener('click', () => { filter = b.dataset.f; renderPhotos(); })
  );

  function timeAgo(iso) {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderPhotos() {
    const all = [...photos.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const counts = { pending: 0, approved: 0, hidden: 0 };
    all.forEach((p) => counts[p.status]++);
    $('cPending').textContent = counts.pending;
    $('cApproved').textContent = counts.approved;
    $('cHidden').textContent = counts.hidden;
    $('cAll').textContent = all.length;
    document.querySelectorAll('#filterTabs button').forEach((b) => b.classList.toggle('active', b.dataset.f === filter));
    const list = filter === 'all' ? all : all.filter((p) => p.status === filter);
    $('noPhotos').classList.toggle('hidden', list.length > 0);
    $('photoGrid').innerHTML = list
      .map((p) => `
        <figure class="ph st-${p.status}" data-id="${p.id}">
          <img src="${escapeHtml(url(p.url))}" loading="lazy" alt="" />
          <figcaption>
            <b>${escapeHtml(p.name || '—')}</b>
            <span class="muted small">${timeAgo(p.createdAt)}${p.ref ? ' · ' + escapeHtml(p.ref) : ''}</span>
          </figcaption>
          <div class="ph-actions">
            ${p.status !== 'approved' ? '<button type="button" data-act="approved" class="ok" title="Show on screen">✓</button>' : ''}
            ${p.status !== 'hidden' ? '<button type="button" data-act="hidden" title="Hide">⦸</button>' : ''}
            <button type="button" data-act="delete" class="del" title="Delete">🗑</button>
          </div>
          <span class="status">${p.status === 'approved' ? 'on screen' : p.status}</span>
        </figure>`)
      .join('');
    schedulePreview();
  }

  $('photoGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.ph').dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'delete') {
        if (!confirm('Delete this photo permanently?')) return;
        await call(`api/admin/photos/${id}`, { method: 'DELETE' });
        photos.delete(id);
      } else {
        const { photo } = await call(`api/admin/photos/${id}`, { method: 'PATCH', body: { status: act } });
        photos.set(id, photo);
      }
      renderPhotos();
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });

  $('approveAll').onclick = async () => {
    const { approved } = await call(`api/admin/events/${EVENT}/approve-all`, { method: 'POST' });
    toast(`${approved} photo(s) sent to the screen`);
    const data = await call(`api/admin/events/${EVENT}`);
    photos = new Map(data.photos.map((p) => [p.id, p]));
    renderPhotos();
  };

  $('clearEvent').onclick = async () => {
    if (!confirm(`Delete ALL photos of event "${EVENT}"? This cannot be undone.`)) return;
    const { removed } = await call(`api/admin/events/${EVENT}/photos`, { method: 'DELETE' });
    photos.clear();
    renderPhotos();
    toast(`${removed} photo(s) deleted`);
  };

  // ------------------------------------------------------------ settings
  function fillSettings() {
    $('autoApprove').checked = !!settings.autoApprove;
    $('spotlight').checked = !!display.spotlight;
    $('showQr').checked = !!display.showQr;
    $('caption').value = display.caption || '';
    $('qrUrl').value = display.qrUrl || '';
    $('background').value = /^#[0-9a-f]{6}$/i.test(display.background) ? display.background : '#0b0b14';
  }

  $('saveSettings').onclick = async () => {
    try {
      const s = await call(`api/admin/events/${EVENT}/settings`, { method: 'PUT', body: { autoApprove: $('autoApprove').checked } });
      settings = s.settings;
      await setDisplay({
        spotlight: $('spotlight').checked,
        showQr: $('showQr').checked,
        caption: $('caption').value,
        qrUrl: $('qrUrl').value.trim(),
        background: $('background').value,
      });
      renderLinks();
      schedulePreview();
      toast('Settings saved');
    } catch (e) {
      toast('Error: ' + e.message);
    }
  };

  // ------------------------------------------------------------ boot
  async function boot() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    await loadEvent();
    setInterval(() => { if (filter !== 'hidden') renderPhotos(); }, 30000); // refresh "x ago"
  }

  (async () => {
    if (KEY && (await tryLogin(KEY))) boot();
    else $('login').classList.remove('hidden');
  })();
})();
