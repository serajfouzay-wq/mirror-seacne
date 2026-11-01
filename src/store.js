'use strict';

/**
 * Tiny JSON-file store. No database needed, so the module can be dropped into
 * any host app. Swap this file for a DB-backed implementation with the same
 * methods if your RSVP system already has a database you want to reuse.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DISPLAY = {
  mode: 'wall', // 'wall' | 'scatter' | 'shape'
  shape: {
    type: 'text', // 'text' | 'preset' | 'image'
    text: 'HELLO',
    font: 'Anton',
    preset: 'heart',
    image: null, // data URL of a mask image (logo etc.)
    invert: false,
  },
  detail: 220, // minimum number of tiles used to draw a shape (higher = sharper)
  gap: 2, // px between tiles
  repeat: true, // reuse photos when there are fewer photos than tiles
  background: '#0b0b14',
  showQr: true,
  caption: 'Scan, take a selfie & join the wall!',
  spotlight: true, // new photos pop up big before joining the wall
  qrUrl: '', // QR target on the screen; empty = this module's guest page for the event
  rev: 0, // bumped on every change
  layoutRev: 0, // bumped when the arrangement changes; screens replay the fly-in animation
};

const DEFAULT_SETTINGS = {
  autoApprove: false, // false = admin must approve before a photo hits the screen
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.uploadDir = path.join(dataDir, 'uploads');
    this.dbFile = path.join(dataDir, 'db.json');
    fs.mkdirSync(this.uploadDir, { recursive: true });
    this.db = { photos: [], displays: {}, settings: {} };
    if (fs.existsSync(this.dbFile)) {
      try {
        this.db = Object.assign(this.db, JSON.parse(fs.readFileSync(this.dbFile, 'utf8')));
      } catch (e) {
        console.error('[mosaic] could not read db.json, starting empty:', e.message);
      }
    }
    this._saveTimer = null;
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this._saveTimer);
    const tmp = this.dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.dbFile);
  }

  // ---------- events ----------
  listEvents() {
    const names = new Set([
      ...this.db.photos.map((p) => p.event),
      ...Object.keys(this.db.displays),
      ...Object.keys(this.db.settings),
    ]);
    return [...names].sort().map((event) => {
      const photos = this.db.photos.filter((p) => p.event === event);
      return {
        event,
        total: photos.length,
        approved: photos.filter((p) => p.status === 'approved').length,
        pending: photos.filter((p) => p.status === 'pending').length,
      };
    });
  }

  // ---------- photos ----------
  listPhotos(event, status) {
    return this.db.photos.filter(
      (p) => p.event === event && (!status || p.status === status)
    );
  }

  getPhoto(id) {
    return this.db.photos.find((p) => p.id === id) || null;
  }

  findByRef(event, ref) {
    if (!ref) return null;
    return this.db.photos.find((p) => p.event === event && p.ref === ref) || null;
  }

  /** Saves image bytes and creates (or replaces, when `ref` matches) a photo. */
  addPhoto({ event, name, ref, buffer, ext, status, meta }) {
    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}.${ext}`;
    fs.writeFileSync(path.join(this.uploadDir, file), buffer);

    let replaced = null;
    const existing = this.findByRef(event, ref);
    if (existing) {
      replaced = clone(existing);
      this._unlink(existing.file);
      this.db.photos = this.db.photos.filter((p) => p.id !== existing.id);
    }

    const photo = {
      id,
      event,
      name: (name || '').slice(0, 80),
      ref: ref ? String(ref).slice(0, 120) : null,
      status,
      file,
      meta: meta || null,
      createdAt: new Date().toISOString(),
    };
    this.db.photos.push(photo);
    this._save();
    return { photo, replaced };
  }

  updatePhoto(id, patch) {
    const p = this.getPhoto(id);
    if (!p) return null;
    if (patch.status && ['pending', 'approved', 'hidden'].includes(patch.status)) {
      p.status = patch.status;
    }
    if (typeof patch.name === 'string') p.name = patch.name.slice(0, 80);
    this._save();
    return p;
  }

  deletePhoto(id) {
    const p = this.getPhoto(id);
    if (!p) return null;
    this._unlink(p.file);
    this.db.photos = this.db.photos.filter((x) => x.id !== id);
    this._save();
    return p;
  }

  clearEvent(event) {
    const removed = this.listPhotos(event);
    removed.forEach((p) => this._unlink(p.file));
    this.db.photos = this.db.photos.filter((p) => p.event !== event);
    this._save();
    return removed;
  }

  _unlink(file) {
    try {
      fs.unlinkSync(path.join(this.uploadDir, file));
    } catch (_) {
      /* already gone */
    }
  }

  // ---------- display state (what the big screen shows) ----------
  getDisplay(event) {
    const stored = this.db.displays[event] || {};
    return Object.assign(clone(DEFAULT_DISPLAY), stored, {
      shape: Object.assign(clone(DEFAULT_DISPLAY.shape), stored.shape || {}),
    });
  }

  setDisplay(event, patch) {
    const current = this.getDisplay(event);
    patch = patch || {};
    const now = Date.now();
    const layoutChanged = ['mode', 'shape', 'detail', 'gap', 'repeat'].some((k) => k in patch);
    const next = Object.assign(current, patch, {
      shape: Object.assign(current.shape, patch.shape || {}),
      rev: now,
      layoutRev: layoutChanged ? now : current.layoutRev,
    });
    this.db.displays[event] = next;
    this._save();
    return next;
  }

  // ---------- per-event settings ----------
  getSettings(event) {
    return Object.assign(clone(DEFAULT_SETTINGS), this.db.settings[event] || {});
  }

  setSettings(event, patch) {
    const next = Object.assign(this.getSettings(event), patch || {});
    this.db.settings[event] = next;
    this._save();
    return next;
  }
}

module.exports = { Store, DEFAULT_DISPLAY, DEFAULT_SETTINGS };
