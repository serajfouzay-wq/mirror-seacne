/* Shared helpers for the three pages. Every URL is relative so the module works
 * wherever the host app mounts it (/, /mosaic, /events/photo-wall, ...). */
(function (global) {
  'use strict';

  const params = new URLSearchParams(location.search);

  function cleanEvent(v) {
    const s = String(v || '').trim();
    return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : 'main';
  }

  // Base URL of the module = folder of the current page ("/mosaic/screen" -> "/mosaic/")
  const BASE = new URL('./', location.href).href;
  const url = (p) => new URL(p, BASE).href;

  let configPromise = null;
  function config() {
    if (!configPromise) configPromise = fetch(url('config.json')).then((r) => r.json());
    return configPromise;
  }

  async function api(path, { method = 'GET', body, key } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['x-admin-key'] = key;
    const res = await fetch(url(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Connect to the live channel and join an event room. onJoin runs after every (re)connect. */
  async function connect({ event, role, key, onJoin, onStatus }) {
    const cfg = await config();
    if (!cfg.realtime || typeof io === 'undefined') {
      console.warn('Realtime not available; falling back to polling');
      return null;
    }
    const origin = new URL(BASE).origin;
    const socket = io(origin + cfg.namespace, { path: cfg.socketPath, transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('join', { event, role, key }, (res) => {
        if (onStatus) onStatus(res && res.ok ? 'online' : 'error');
        if (res && res.ok && onJoin) onJoin();
      });
    });
    socket.on('disconnect', () => onStatus && onStatus('offline'));
    return socket;
  }

  function loadFonts() {
    if (!global.ShapeEngine || document.getElementById('mosaic-fonts')) return;
    const l = document.createElement('link');
    l.id = 'mosaic-fonts';
    l.rel = 'stylesheet';
    l.href = ShapeEngine.GOOGLE_FONTS_URL;
    document.head.appendChild(l);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.Mosaic = { params, cleanEvent, BASE, url, config, api, connect, loadFonts, escapeHtml };
})(window);
