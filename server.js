'use strict';
const express   = require('express');
const webpush   = require('web-push');
const WebSocket = require('ws');
const path      = require('path');

// ── VAPID configuration ────────────────────────────────────
// Public key is safe to embed. Private key MUST come from an
// environment variable — never commit it to source control.
const VAPID_PUBLIC  = 'BAFUQE0sqgk8JoLQmCcQiEqvgfe2ynIMCdoVj4BHfpFZLgIIUf0Zfle2vvkh9d923XyJ0xCFoT3mIihcfaqKFas';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PRIVATE) {
  console.error('FATAL: VAPID_PRIVATE_KEY environment variable is not set.');
  process.exit(1);
}

webpush.setVapidDetails('mailto:80194846+Skeletoon1@users.noreply.github.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Express app ────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's reverse proxy so req.ip returns the real client IP,
// not the proxy IP (without this, all users share one rate-limit bucket)
app.set('trust proxy', 1);

// Limit body size — prevents oversized payload attacks
app.use(express.json({ limit: '10kb' }));

// Serve only the public/ folder — server.js and package.json are never exposed
app.use(express.static(path.join(__dirname, 'public')));

// ── Input validation helpers ───────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

function isValidCoords(lat, lon) {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    isFinite(lat) && isFinite(lon) &&
    lat >= -90  && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
}

// ── Simple in-memory rate limiter (no extra deps) ──────────
const rateWindows = new Map(); // IP → { count, resetAt }
const RATE_LIMIT  = 20;        // max requests
const RATE_WINDOW = 60_000;    // per 60 seconds

function rateLimit(req, res, next) {
  const ip  = req.ip || 'unknown';
  const now = Date.now();
  let   entry = rateWindows.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_WINDOW };
    rateWindows.set(ip, entry);
    return next();
  }
  if (entry.count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'too many requests' });
  }
  entry.count++;
  next();
}

// Periodically clean up stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateWindows) {
    if (now > entry.resetAt) rateWindows.delete(ip);
  }
}, 120_000);

// ── User store: id → { subscription, lat, lon, lastNotif, updatedAt } ──
const users    = new Map();
const MAX_USERS = 500; // cap to prevent memory exhaustion

// ── API routes ─────────────────────────────────────────────

// Public key for client-side push subscription setup
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

// Register push subscription + initial location
app.post('/subscribe', rateLimit, (req, res) => {
  const { id, subscription, lat, lon } = req.body;

  if (!isValidUUID(id))         return res.status(400).json({ error: 'invalid id' });
  if (!subscription?.endpoint)  return res.status(400).json({ error: 'invalid subscription' });

  // Reject if server is at capacity (and this is a new registration)
  if (users.size >= MAX_USERS && !users.has(id)) {
    return res.status(503).json({ error: 'server at capacity' });
  }

  const safeLat = isValidCoords(lat, lon) ? lat : 46.877;
  const safeLon = isValidCoords(lat, lon) ? lon : -96.789;

  users.set(id, {
    subscription,
    lat:       safeLat,
    lon:       safeLon,
    lastNotif: 0,
    updatedAt: Date.now()
  });

  console.log(`[+] Registered user — total: ${users.size}`);
  res.json({ ok: true });
});

// Update location (called every 30s by the PWA)
app.post('/location', rateLimit, (req, res) => {
  const { id, lat, lon } = req.body;

  if (!isValidUUID(id))            return res.status(400).json({ error: 'invalid id' });
  if (!isValidCoords(lat, lon))    return res.status(400).json({ error: 'invalid coordinates' });

  const user = users.get(id);
  if (user) {
    user.lat       = lat;
    user.lon       = lon;
    user.updatedAt = Date.now();
  }

  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Lightning Tracker running on port ${PORT}`));

// ── Haversine distance in miles ────────────────────────────
function distMi(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Send push to a single user ─────────────────────────────
const NOTIF_COOLDOWN = 30_000;

async function sendPush(id, user, dist) {
  const now = Date.now();
  if (now - user.lastNotif < NOTIF_COOLDOWN) return;
  user.lastNotif = now;

  const danger  = dist <= 5;
  const payload = JSON.stringify({
    title: danger ? '⚡ LIGHTNING VERY CLOSE!' : '⚡ Lightning Alert',
    body:  `Strike ${dist.toFixed(1)} miles from your location`,
    danger
  });

  try {
    await webpush.sendNotification(user.subscription, payload);
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      users.delete(id); // subscription expired
    }
  }
}

// ── Process incoming strike ────────────────────────────────
function onStrike(lat, lon) {
  // Validate the incoming strike coordinates before processing
  if (!isValidCoords(lat, lon)) return;

  const now = Date.now();
  for (const [id, user] of users) {
    if (now - user.updatedAt > 7_200_000) { users.delete(id); continue; }
    const dist = distMi(user.lat, user.lon, lat, lon);
    if (dist <= 10) sendPush(id, user, dist);
  }
}

// ── Blitzortung WebSocket feed ─────────────────────────────
const WS_SERVERS = [
  'wss://ws7.blitzortung.org:3004/',
  'wss://ws8.blitzortung.org:3006/',
  'wss://ws1.blitzortung.org:3004/',
  'wss://ws2.blitzortung.org:3006/',
  'wss://ws3.blitzortung.org:3004/',
];
let wsIdx = 0;

function connectFeed() {
  const url = WS_SERVERS[wsIdx++ % WS_SERVERS.length];
  const ws  = new WebSocket(url);

  ws.on('open', () => {
    ws.send(JSON.stringify({ a: 111 }));
    console.log('Lightning feed connected');
  });

  ws.on('message', data => {
    try {
      const d = JSON.parse(data);
      if (typeof d.lat === 'number' && typeof d.lon === 'number') onStrike(d.lat, d.lon);
    } catch (_) {}
  });

  ws.on('close', () => { setTimeout(connectFeed, 5000); });
  ws.on('error', ()  => { try { ws.terminate(); } catch (_) {} });
}

connectFeed();
