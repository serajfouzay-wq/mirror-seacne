/* Shape engine: turns text / preset shapes / uploaded images into a set of square
 * tile positions ("slots") that photos fly into. Shared by the big screen and the
 * admin preview so both always agree. No dependencies. */
(function (global) {
  'use strict';

  // ---- preset shapes, drawn in a 100x100 box ---------------------------------
  function poly(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }
  function starPts(n, r1, r2, cx = 50, cy = 52) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 ? r2 : r1;
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }
  function circle(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  function cut(ctx, fn) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    fn();
    ctx.restore();
  }

  const PRESETS = {
    heart: { label: 'Heart', draw(ctx) {
      ctx.beginPath();
      ctx.moveTo(50, 92);
      ctx.bezierCurveTo(18, 68, 2, 50, 2, 30);
      ctx.bezierCurveTo(2, 14, 14, 4, 28, 4);
      ctx.bezierCurveTo(38, 4, 46, 10, 50, 19);
      ctx.bezierCurveTo(54, 10, 62, 4, 72, 4);
      ctx.bezierCurveTo(86, 4, 98, 14, 98, 30);
      ctx.bezierCurveTo(98, 50, 82, 68, 50, 92);
      ctx.fill();
    } },
    star: { label: 'Star', draw: (ctx) => poly(ctx, starPts(5, 50, 20, 50, 54)) },
    circle: { label: 'Circle', draw: (ctx) => circle(ctx, 50, 50, 49) },
    ring: { label: 'Ring', draw(ctx) { circle(ctx, 50, 50, 49); cut(ctx, () => circle(ctx, 50, 50, 30)); } },
    crescent: { label: 'Crescent', draw(ctx) { circle(ctx, 46, 50, 46); cut(ctx, () => circle(ctx, 64, 42, 38)); } },
    diamond: { label: 'Diamond', draw: (ctx) => poly(ctx, [[50, 1], [96, 50], [50, 99], [4, 50]]) },
    hexagon: { label: 'Hexagon', draw: (ctx) => poly(ctx, [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (Math.PI / 3) * i; return [50 + 49 * Math.cos(a), 50 + 49 * Math.sin(a)];
    })) },
    triangle: { label: 'Triangle', draw: (ctx) => poly(ctx, [[50, 4], [98, 92], [2, 92]]) },
    plus: { label: 'Plus', draw: (ctx) => poly(ctx, [[35, 2], [65, 2], [65, 35], [98, 35], [98, 65], [65, 65], [65, 98], [35, 98], [35, 65], [2, 65], [2, 35], [35, 35]]) },
    smile: { label: 'Smiley', draw(ctx) {
      circle(ctx, 50, 50, 49);
      cut(ctx, () => {
        circle(ctx, 34, 36, 8);
        circle(ctx, 66, 36, 8);
        ctx.beginPath();
        ctx.lineWidth = 9;
        ctx.lineCap = 'round';
        ctx.arc(50, 52, 26, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
      });
    } },
    bolt: { label: 'Lightning', draw: (ctx) => poly(ctx, [[60, 1], [14, 56], [44, 56], [36, 99], [86, 40], [55, 40]]) },
    check: { label: 'Check', draw: (ctx) => poly(ctx, [[4, 54], [18, 40], [38, 60], [82, 14], [96, 28], [38, 86]]) },
    house: { label: 'House', draw(ctx) {
      poly(ctx, [[50, 4], [98, 46], [86, 46], [86, 96], [14, 96], [14, 46], [2, 46]]);
      cut(ctx, () => ctx.fillRect(40, 64, 20, 32));
    } },
    ring2: { label: 'Wedding rings', draw(ctx) {
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(36, 54, 28, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(64, 54, 28, 0, Math.PI * 2); ctx.stroke();
      poly(ctx, [[36, 14], [30, 6], [42, 6]]);
    } },
  };

  const FONTS = [
    { id: 'Anton', css: '"Anton", Impact, sans-serif', weight: '400' },
    { id: 'Archivo Black', css: '"Archivo Black", "Arial Black", sans-serif', weight: '400' },
    { id: 'Lilita One', css: '"Lilita One", "Arial Rounded MT Bold", sans-serif', weight: '400' },
    { id: 'Cairo', css: '"Cairo", Tahoma, sans-serif', weight: '900' }, // Arabic + Latin
    { id: 'Tajawal', css: '"Tajawal", Tahoma, sans-serif', weight: '900' }, // Arabic + Latin
    { id: 'Arial', css: 'Arial, Helvetica, sans-serif', weight: '900' },
  ];
  const GOOGLE_FONTS_URL =
    'https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=Cairo:wght@900&family=Lilita+One&family=Tajawal:wght@900&display=swap';

  function fontFor(id) {
    return FONTS.find((f) => f.id === id) || FONTS[0];
  }

  // ---- image loading for "image" shapes (cached) ------------------------------
  const imgCache = new Map();
  function loadImage(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
    imgCache.set(src, p);
    return p;
  }

  /**
   * Render a shape into a mask canvas of size w x h (white = inside).
   * Async because fonts / images may need loading.
   */
  async function renderMask(shape, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    const pad = Math.round(Math.min(w, h) * 0.06);
    const bw = w - pad * 2;
    const bh = h - pad * 2;
    const type = shape && shape.type;

    if (type === 'preset') {
      const p = PRESETS[shape.preset] || PRESETS.heart;
      const size = Math.min(bw, bh);
      ctx.save();
      ctx.translate((w - size) / 2, (h - size) / 2);
      ctx.scale(size / 100, size / 100);
      p.draw(ctx);
      ctx.restore();
    } else if (type === 'image' && shape.image) {
      const im = await loadImage(shape.image);
      const k = Math.min(bw / im.width, bh / im.height);
      const iw = Math.max(1, Math.round(im.width * k));
      const ih = Math.max(1, Math.round(im.height * k));
      const t = document.createElement('canvas');
      t.width = iw;
      t.height = ih;
      const tctx = t.getContext('2d');
      tctx.drawImage(im, 0, 0, iw, ih);
      const src = tctx.getImageData(0, 0, iw, ih);
      const d = src.data;
      let hasAlpha = false;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 240) { hasAlpha = true; break; }
      const out = ctx.createImageData(iw, ih);
      const o = out.data;
      for (let i = 0; i < d.length; i += 4) {
        let inside = hasAlpha
          ? d[i + 3] > 127
          : 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 128; // dark pixels = shape
        if (shape.invert) inside = !inside;
        o[i] = o[i + 1] = o[i + 2] = 255;
        o[i + 3] = inside ? 255 : 0;
      }
      ctx.putImageData(out, Math.round((w - iw) / 2), Math.round((h - ih) / 2));
    } else {
      // text (default). Supports several lines separated by "\n" or "|".
      const f = fontFor(shape && shape.font);
      const lines = String((shape && shape.text) || ' ').split(/\n|\|/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) lines.push(' ');
      if (document.fonts && document.fonts.load) {
        // never let a slow/offline font CDN block the show: fall back after 2.5s
        const load = document.fonts.load(`${f.weight} 100px ${f.css.split(',')[0]}`, lines.join('')).catch(() => {});
        await Promise.race([load, new Promise((r) => setTimeout(r, 2500))]);
      }
      const base = 200;
      ctx.font = `${f.weight} ${base}px ${f.css}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const metrics = lines.map((l) => ctx.measureText(l));
      const asc = Math.max(...metrics.map((m) => m.actualBoundingBoxAscent || base * 0.75));
      const desc = Math.max(...metrics.map((m) => m.actualBoundingBoxDescent || base * 0.1));
      const lineH = asc + desc;
      const gapH = base * 0.15;
      const totalH = lineH * lines.length + gapH * (lines.length - 1);
      const maxW = Math.max(...metrics.map((m) => (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || m.width) || m.width));
      const k = Math.min(bw / maxW, bh / totalH);
      ctx.font = `${f.weight} ${base * k}px ${f.css}`;
      let y = (h - totalH * k) / 2 + asc * k;
      for (let i = 0; i < lines.length; i++) {
        const m = metrics[i];
        // centre on the real ink box (handles fonts with uneven side bearings)
        const off = ((m.actualBoundingBoxLeft || 0) - (m.actualBoundingBoxRight || 0)) / 2;
        ctx.fillText(lines[i], w / 2 + off * k, y);
        y += (lineH + gapH) * k;
      }
    }
    return c;
  }

  /** Summed-area table of a mask (1 where alpha > 127) for O(1) coverage queries. */
  function buildSAT(maskCanvas) {
    const w = maskCanvas.width;
    const h = maskCanvas.height;
    const d = maskCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const W = w + 1;
    const sat = new Uint32Array(W * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) {
        row += d[((y - 1) * w + (x - 1)) * 4 + 3] > 127 ? 1 : 0;
        sat[y * W + x] = sat[(y - 1) * W + x] + row;
      }
    }
    return { sat, w, h };
  }

  function cellsAt(S, cell, threshold, collect) {
    const { sat, w, h } = S;
    const W = w + 1;
    const cols = Math.floor(w / cell);
    const rows = Math.floor(h / cell);
    const ox = (w - cols * cell) / 2;
    const oy = (h - rows * cell) / 2;
    const out = collect ? [] : null;
    let count = 0;
    for (let r = 0; r < rows; r++) {
      const y0 = Math.round(oy + r * cell);
      const y1 = Math.min(h, Math.round(oy + (r + 1) * cell));
      for (let c = 0; c < cols; c++) {
        const x0 = Math.round(ox + c * cell);
        const x1 = Math.min(w, Math.round(ox + (c + 1) * cell));
        const area = (x1 - x0) * (y1 - y0);
        if (area <= 0) continue;
        const sum = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
        if (sum / area >= threshold) {
          count++;
          if (out) out.push({ x: ox + (c + 0.5) * cell, y: oy + (r + 0.5) * cell, r, c });
        }
      }
    }
    return collect ? out : count;
  }

  /**
   * Compute tile slots for a shape.
   * @param shape   display.shape
   * @param W,H     drawing area in CSS px
   * @param target  minimum number of tiles wanted
   * @returns {slots:[{x,y}], size}  (centre points in CSS px, tile size in CSS px)
   */
  async function computeShapeSlots(shape, W, H, target) {
    const k = Math.min(1, 900 / Math.max(W, H)); // work at reduced resolution for speed
    const mw = Math.max(20, Math.round(W * k));
    const mh = Math.max(20, Math.round(H * k));
    const mask = await renderMask(shape, mw, mh);
    const S = buildSAT(mask);
    const threshold = 0.5;
    target = Math.max(1, Math.round(target));

    // Largest cell size that still yields >= target tiles (binary search).
    let lo = 1.5;
    let hi = Math.min(mw, mh);
    if (cellsAt(S, lo, threshold) < target) hi = lo; // can't reach target; use the finest grid
    for (let i = 0; i < 28 && hi - lo > 0.05; i++) {
      const mid = (lo + hi) / 2;
      if (cellsAt(S, mid, threshold) >= target) lo = mid;
      else hi = mid;
    }
    const cell = lo;
    const slots = cellsAt(S, cell, threshold, true).map((s) => ({ x: s.x / k, y: s.y / k, r: s.r, c: s.c }));
    return { slots, size: cell / k, mask };
  }

  // ---- other layouts ---------------------------------------------------------
  /** Best square grid for n tiles inside W x H. */
  function gridSlots(n, W, H, maxSize) {
    if (n <= 0) return { slots: [], size: 0 };
    let best = { size: 0, cols: 1, rows: 1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.min(W / cols, H / rows);
      if (size > best.size) best = { size, cols, rows };
    }
    const size = Math.min(best.size, maxSize || Infinity);
    const { cols, rows } = best;
    const ox = (W - cols * size) / 2;
    const oy = (H - rows * size) / 2;
    const slots = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      // centre an incomplete last row
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const rowOx = ox + ((cols - inRow) * size) / 2;
      slots.push({ x: rowOx + (c + 0.5) * size, y: oy + (r + 0.5) * size });
    }
    return { slots, size };
  }

  // Deterministic PRNG so every screen showing the same event looks identical.
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  global.ShapeEngine = {
    PRESETS, FONTS, GOOGLE_FONTS_URL, fontFor,
    renderMask, computeShapeSlots, gridSlots, rng, shuffle,
  };
})(window);
