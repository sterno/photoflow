#!/usr/bin/env node
// PhotoFlow end-to-end simulation.
//
// Drives a realistic publish/subscribe scenario against a running PhotoFlow
// instance: provisions a dedicated simulation event + a handful of publisher
// and subscriber users, then runs concurrent actor loops for a configurable
// duration. Publishers download photos from picsum.photos and POST them to
// /api/upload; subscribers poll the stream, browse with random filters,
// build collections, and export files. On exit (clean or signalled), the
// script purges the simulation event's media/S3, deletes its collections
// and users, and leaves only an empty Event row behind.
//
// Usage:
//   node scripts/simulate-event.mjs --base-url=http://localhost:3000 --duration=10
// See `--help` for all flags.

import { setTimeout as sleep } from 'node:timers/promises';

// ---------- args & config ----------

const HELP = `
PhotoFlow simulation runner

Flags (env var in parens):
  --base-url=URL          Target PhotoFlow base URL (PF_BASE_URL) [http://localhost:3000]
  --admin-user=NAME       Admin username (PF_ADMIN_USER) [admin]
  --admin-pass=PASS       Admin password (PF_ADMIN_PASS) [admin123]
  --duration=MIN          Run duration in minutes (PF_DURATION) [10]
  --publishers=N          Concurrent publisher actors (PF_PUBLISHERS) [2]
  --subscribers=N         Concurrent subscriber actors (PF_SUBSCRIBERS) [3]
  --sim-password=PASS     Password assigned to simulation users (PF_SIM_PASSWORD) [simulate123]
  --photo-size=WxH        Picsum photo dimensions [1600x1066]
  --no-cleanup            Leave media, collections, and users in place
  --keep-users            Skip user deletion (keeps media purge + collection delete)
  --i-know-what-im-doing  Bypass the prod-host safety check
  --help                  Show this help
`;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const config = {
  baseUrl: (args['base-url'] || process.env.PF_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  adminUser: args['admin-user'] || process.env.PF_ADMIN_USER || 'admin',
  adminPass: args['admin-pass'] || process.env.PF_ADMIN_PASS || 'admin123',
  durationMin: Number(args.duration ?? process.env.PF_DURATION ?? 10),
  publishers: Number(args.publishers ?? process.env.PF_PUBLISHERS ?? 2),
  subscribers: Number(args.subscribers ?? process.env.PF_SUBSCRIBERS ?? 3),
  simPassword: args['sim-password'] || process.env.PF_SIM_PASSWORD || 'simulate123',
  photoSize: args['photo-size'] || '1600x1066',
  cleanup: !args['no-cleanup'],
  keepUsers: Boolean(args['keep-users']),
  bypassSafety: Boolean(args['i-know-what-im-doing']),
};

if (/prod|production/i.test(config.baseUrl) && !config.bypassSafety) {
  console.error(`Refusing to run against ${config.baseUrl} — pass --i-know-what-im-doing to override.`);
  process.exit(2);
}

const [photoW, photoH] = config.photoSize.split('x').map(Number);
if (!photoW || !photoH) {
  console.error(`Bad --photo-size value: ${config.photoSize}`);
  process.exit(2);
}

// ---------- naming ----------

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const PUBLISHER_NAMES = ['Alice', 'Bob', 'Carmen', 'Diego', 'Eun', 'Farah'];
const SUBSCRIBER_NAMES = ['Hugo', 'Ines', 'Jules', 'Kira', 'Liam', 'Maya'];

function publisherUsername(i) { return `sim_pub_${PUBLISHER_NAMES[i % PUBLISHER_NAMES.length].toLowerCase()}_${i}`; }
function subscriberUsername(i) { return `sim_sub_${SUBSCRIBER_NAMES[i % SUBSCRIBER_NAMES.length].toLowerCase()}_${i}`; }
function publisherDisplayName(i) { return `${PUBLISHER_NAMES[i % PUBLISHER_NAMES.length]} Publisher`; }
function subscriberDisplayName(i) { return `${SUBSCRIBER_NAMES[i % SUBSCRIBER_NAMES.length]} Subscriber`; }

// ---------- logging ----------

const startedAt = Date.now();
function ts() {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6, ' ');
  return `[+${elapsed}s]`;
}
function log(actor, msg) { console.log(`${ts()} ${actor.padEnd(18)} ${msg}`); }
function warn(actor, msg) { console.warn(`${ts()} ${actor.padEnd(18)} WARN ${msg}`); }
function err(actor, msg) { console.error(`${ts()} ${actor.padEnd(18)} ERROR ${msg}`); }

// ---------- cookie jar + request helper ----------

function makeJar() {
  return new Map(); // name -> value
}

function applySetCookie(jar, header) {
  if (!header) return;
  const headers = Array.isArray(header) ? header : [header];
  for (const h of headers) {
    // Split multiple Set-Cookie joined with comma (Node sometimes does this).
    // We split on ", " followed by a token=, which is fragile but works for
    // the cookies NextAuth emits. Simplest path: split by comma followed by
    // optional whitespace and a cookie-name-like char before '='.
    const parts = h.split(/,(?=\s*[a-zA-Z0-9_.\-]+=)/);
    for (const part of parts) {
      const first = part.split(';')[0].trim();
      const eq = first.indexOf('=');
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      if (value === '' || /expires=thu, 01 jan 1970/i.test(part)) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(jar, method, path, { body, headers = {}, raw = false } = {}) {
  const url = path.startsWith('http') ? path : `${config.baseUrl}${path}`;
  const h = { ...headers };
  if (jar.size > 0) h.cookie = cookieHeader(jar);
  const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
  // Node's fetch headers.getSetCookie() returns string[] (Node 19.7+).
  const sc = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie');
  applySetCookie(jar, sc);
  if (raw) return res;
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* not JSON, leave null */ }
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ---------- NextAuth credentials login ----------

async function login(jar, username, password) {
  const csrfRes = await request(jar, 'GET', '/api/auth/csrf');
  const csrfToken = csrfRes.json?.csrfToken;
  if (!csrfToken) throw new Error(`Could not fetch CSRF token (status ${csrfRes.status})`);

  const form = new URLSearchParams({
    csrfToken,
    username,
    password,
    callbackUrl: '/',
    json: 'true',
  });
  const loginRes = await request(jar, 'POST', '/api/auth/callback/credentials', {
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  // Success: 200 with { url } JSON, or 302 redirect. Failure usually 401/302 to error page.
  const ok = loginRes.status === 200 || loginRes.status === 302;
  if (!ok) throw new Error(`Login failed for ${username}: HTTP ${loginRes.status}`);

  const hasSession = [...jar.keys()].some((n) => /session-token/i.test(n));
  if (!hasSession) throw new Error(`Login for ${username} returned no session cookie`);

  const profile = await request(jar, 'GET', '/api/profile');
  if (profile.status !== 200) throw new Error(`Profile check failed for ${username}: HTTP ${profile.status}`);
  return profile.json;
}

// ---------- API helpers ----------

async function apiJson(jar, method, path, body) {
  const res = await request(jar, method, path, {
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
  });
  if (res.status >= 400) {
    const e = new Error(`${method} ${path} -> HTTP ${res.status}${res.json?.error ? `: ${res.json.error}` : ''}`);
    e.status = res.status;
    e.body = res.json ?? res.text;
    throw e;
  }
  return res.json;
}

async function createUser(adminJar, { username, name, role }) {
  try {
    return await apiJson(adminJar, 'POST', '/api/admin/users', {
      username,
      name,
      password: config.simPassword,
      role,
    });
  } catch (e) {
    if (e.status === 409) {
      // already exists — reset its password so login still works
      const list = await apiJson(adminJar, 'GET', '/api/admin/users');
      const existing = list.users.find((u) => u.username === username);
      if (!existing) throw e;
      await apiJson(adminJar, 'PATCH', `/api/admin/users/${existing.id}`, {
        password: config.simPassword,
        role,
        name,
      });
      return { user: { ...existing, name, role } };
    }
    throw e;
  }
}

async function deleteUser(adminJar, id) {
  await apiJson(adminJar, 'DELETE', `/api/admin/users/${id}`);
}

// ---------- bootstrap ----------

async function bootstrap() {
  const adminJar = makeJar();
  log('bootstrap', `target: ${config.baseUrl}`);
  log('bootstrap', `logging in as admin "${config.adminUser}"`);
  await login(adminJar, config.adminUser, config.adminPass);

  const eventName = `SIMULATION_${RUN_ID}`;
  log('bootstrap', `creating event "${eventName}"`);
  const eventBody = await apiJson(adminJar, 'POST', '/api/events', {
    name: eventName,
    description: 'Automated simulation run',
    startDate: new Date().toISOString(),
    aiEnabled: true,
  });
  const event = eventBody.event;
  log('bootstrap', `event id=${event.id}; activating (will deactivate any other active event)`);
  await apiJson(adminJar, 'POST', `/api/events/${event.id}/activate`);

  const publishers = [];
  for (let i = 0; i < config.publishers; i++) {
    const username = publisherUsername(i);
    const name = publisherDisplayName(i);
    log('bootstrap', `provisioning publisher ${username}`);
    const { user } = await createUser(adminJar, { username, name, role: 'PUBLISHER' });
    publishers.push({ ...user, username, name, label: `pub:${name.split(' ')[0]}` });
  }
  const subscribers = [];
  for (let i = 0; i < config.subscribers; i++) {
    const username = subscriberUsername(i);
    const name = subscriberDisplayName(i);
    log('bootstrap', `provisioning subscriber ${username}`);
    const { user } = await createUser(adminJar, { username, name, role: 'SUBSCRIBER' });
    subscribers.push({ ...user, username, name, label: `sub:${name.split(' ')[0]}` });
  }
  return { adminJar, event, publishers, subscribers };
}

// ---------- actor behaviours ----------

async function jitter(minMs, maxMs, signal) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  try { await sleep(ms, undefined, { signal }); } catch { /* aborted */ }
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function fetchPicsumPhoto(seed) {
  const url = `https://picsum.photos/seed/${encodeURIComponent(seed)}/${photoW}/${photoH}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`picsum ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, seed };
}

async function runPublisher(actor, ctx, signal) {
  const jar = makeJar();
  try {
    await login(jar, actor.username, config.simPassword);
  } catch (e) {
    err(actor.label, `login failed: ${e.message}`);
    return;
  }
  log(actor.label, 'online');
  while (!signal.aborted) {
    const seed = `${actor.username}-${ctx.stats.uploadAttempts++}-${Date.now()}`;
    try {
      const { buf } = await fetchPicsumPhoto(seed);
      const filename = `${actor.username}-${seed}.jpg`;
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'image/jpeg' }), filename);
      const res = await request(jar, 'POST', '/api/upload', { body: fd });
      if (res.status === 200 && res.json?.mediaId) {
        ctx.recentMediaIds.push(res.json.mediaId);
        if (ctx.recentMediaIds.length > 60) ctx.recentMediaIds.splice(0, ctx.recentMediaIds.length - 60);
        ctx.stats.uploadsOk++;
        log(actor.label, `uploaded ${filename} -> media ${res.json.mediaId}`);
      } else {
        ctx.stats.uploadsFail++;
        warn(actor.label, `upload failed status=${res.status} body=${res.text?.slice(0, 200)}`);
      }
    } catch (e) {
      ctx.stats.uploadsFail++;
      warn(actor.label, `upload error: ${e.message}`);
    }
    await jitter(8000, 20000, signal);
  }
  log(actor.label, 'offline');
}

const FILTER_KEYWORDS = ['stage', 'panel', 'crowd', 'speaker', 'audience', 'lights'];
const SHOT_TYPES = ['panel', 'individual_speaker', 'crowd', 'stage', 'networking', 'presentation'];
const PUBLISH_TEMPLATES = [
  '{YYYY}_{MM}_{DD}_{photographer}_{sequence}',
  '{photographer}-{YYYY}{MM}{DD}-{sequence}',
  'event_{YYYY}-{MM}-{DD}_{sequence}',
];
const PUBLISH_LONG_EDGES = [800, 1600, null];

async function actStreamPoll(actor, jar, ctx) {
  const res = await apiJson(jar, 'GET', '/api/photos/stream');
  ctx.stats.streamPolls++;
  log(actor.label, `stream poll -> ${res.photos?.length ?? 0} photos`);
}

async function actBrowse(actor, jar, ctx) {
  const params = new URLSearchParams();
  const roll = Math.random();
  if (roll < 0.33) params.set('keyword', pickRandom(FILTER_KEYWORDS));
  else if (roll < 0.66) params.set('shotType', pickRandom(SHOT_TYPES));
  else params.set('photographer', pickRandom(PUBLISHER_NAMES));
  const res = await apiJson(jar, 'GET', `/api/photos/browse?${params}`);
  ctx.stats.browses++;
  log(actor.label, `browse ${params} -> ${res.photos?.length ?? res.media?.length ?? 0} hits`);
}

async function actCollection(actor, jar, ctx) {
  if (ctx.recentMediaIds.length < 2) return;
  const sample = [...ctx.recentMediaIds].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 4));
  const created = await apiJson(jar, 'POST', '/api/collections', {
    name: `${actor.name}'s pick ${new Date().toISOString().slice(11, 19)}`,
    eventId: ctx.event.id,
  });
  ctx.simCollectionIds.push(created.collection.id);
  await apiJson(jar, 'POST', `/api/collections/${created.collection.id}/items`, { mediaIds: sample });
  ctx.stats.collectionsCreated++;
  log(actor.label, `created collection ${created.collection.id} with ${sample.length} items`);
}

async function actPublish(actor, jar, ctx) {
  if (ctx.recentMediaIds.length === 0) return;
  const mediaId = pickRandom(ctx.recentMediaIds);
  const template = pickRandom(PUBLISH_TEMPLATES);
  const longEdge = pickRandom(PUBLISH_LONG_EDGES);
  const body = { mediaId, template, sequence: 1 + Math.floor(Math.random() * 99) };
  if (longEdge) body.longEdge = longEdge;
  const res = await request(jar, 'POST', '/api/publish/file', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    raw: true,
  });
  // Drain body so the connection releases.
  const arr = await res.arrayBuffer();
  if (res.status === 200) {
    ctx.stats.publishesOk++;
    log(actor.label, `published media ${mediaId} (${arr.byteLength} bytes, longEdge=${longEdge ?? 'original'})`);
  } else {
    ctx.stats.publishesFail++;
    warn(actor.label, `publish failed status=${res.status}`);
  }
}

async function runSubscriber(actor, ctx, signal) {
  const jar = makeJar();
  try {
    await login(jar, actor.username, config.simPassword);
  } catch (e) {
    err(actor.label, `login failed: ${e.message}`);
    return;
  }
  log(actor.label, 'online');
  while (!signal.aborted) {
    const roll = Math.random();
    try {
      if (roll < 0.6) await actStreamPoll(actor, jar, ctx);
      else if (roll < 0.8) await actBrowse(actor, jar, ctx);
      else if (roll < 0.9) await actCollection(actor, jar, ctx);
      else await actPublish(actor, jar, ctx);
    } catch (e) {
      warn(actor.label, `action error: ${e.message}`);
    }
    await jitter(5000, 15000, signal);
  }
  log(actor.label, 'offline');
}

// ---------- teardown ----------

async function teardown(ctx) {
  if (!config.cleanup) {
    log('teardown', 'skipping (--no-cleanup)');
    return;
  }
  log('teardown', `purging event ${ctx.event.id} media + S3`);
  try {
    const r = await apiJson(ctx.adminJar, 'POST', `/api/events/${ctx.event.id}/purge`);
    log('teardown', `purge: ${r.deletedMedia ?? 0} media rows, ${r.s3Deleted ?? 0} S3 objects`);
  } catch (e) {
    err('teardown', `purge failed: ${e.message}`);
  }

  log('teardown', 'deleting simulation collections');
  try {
    const list = await apiJson(ctx.adminJar, 'GET', `/api/collections?eventId=${ctx.event.id}`);
    const collections = list.collections ?? [];
    for (const c of collections) {
      try {
        await apiJson(ctx.adminJar, 'DELETE', `/api/collections/${c.id}`);
      } catch (e) {
        warn('teardown', `collection ${c.id} delete failed: ${e.message}`);
      }
    }
    log('teardown', `deleted ${collections.length} collection(s)`);
  } catch (e) {
    warn('teardown', `collection cleanup error: ${e.message}`);
  }

  if (config.keepUsers) {
    log('teardown', 'keeping simulation users (--keep-users)');
  } else {
    log('teardown', 'deleting simulation users');
    let deleted = 0;
    for (const u of [...ctx.publishers, ...ctx.subscribers]) {
      try { await deleteUser(ctx.adminJar, u.id); deleted++; }
      catch (e) { warn('teardown', `delete user ${u.username}: ${e.message}`); }
    }
    log('teardown', `deleted ${deleted} user(s)`);
  }

  log('teardown', `Event row "${ctx.event.name}" (${ctx.event.id}) left in place — no event-delete API`);
}

// ---------- main ----------

async function main() {
  console.log(`\nPhotoFlow simulation`);
  console.log(`  target:      ${config.baseUrl}`);
  console.log(`  duration:    ${config.durationMin} min`);
  console.log(`  publishers:  ${config.publishers}`);
  console.log(`  subscribers: ${config.subscribers}`);
  console.log(`  cleanup:     ${config.cleanup ? 'yes' : 'no'}${config.keepUsers ? ' (users kept)' : ''}`);
  console.log(`  WARNING: will deactivate any currently active event.\n`);
  for (let s = 5; s > 0; s--) {
    process.stdout.write(`Starting in ${s}...\r`);
    await sleep(1000);
  }
  process.stdout.write('                       \r');

  const bootstrapped = await bootstrap();
  const ctx = {
    adminJar: bootstrapped.adminJar,
    event: bootstrapped.event,
    publishers: bootstrapped.publishers,
    subscribers: bootstrapped.subscribers,
    recentMediaIds: [],
    simCollectionIds: [],
    stats: {
      uploadAttempts: 0, uploadsOk: 0, uploadsFail: 0,
      streamPolls: 0, browses: 0,
      collectionsCreated: 0,
      publishesOk: 0, publishesFail: 0,
    },
  };

  const ac = new AbortController();
  let teardownPromise = null;
  const onSignal = (sig) => {
    log('signal', `${sig} received, stopping actors`);
    ac.abort();
    if (!teardownPromise) teardownPromise = teardown(ctx).then(() => process.exit(0));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const statsTimer = setInterval(() => {
    const s = ctx.stats;
    log('stats',
      `uploads ok/fail=${s.uploadsOk}/${s.uploadsFail} ` +
      `stream=${s.streamPolls} browse=${s.browses} ` +
      `collections=${s.collectionsCreated} ` +
      `publish ok/fail=${s.publishesOk}/${s.publishesFail} ` +
      `pool=${ctx.recentMediaIds.length}`);
  }, 15000);

  const actorPromises = [
    ...ctx.publishers.map((a) => runPublisher(a, ctx, ac.signal)),
    ...ctx.subscribers.map((a) => runSubscriber(a, ctx, ac.signal)),
  ];

  const durationMs = config.durationMin * 60 * 1000;
  const durationTimer = setTimeout(() => {
    log('main', `duration ${config.durationMin}m reached, stopping`);
    ac.abort();
  }, durationMs);

  await Promise.all(actorPromises);
  clearTimeout(durationTimer);
  clearInterval(statsTimer);

  console.log('\nFinal stats:');
  console.log(JSON.stringify(ctx.stats, null, 2));

  if (!teardownPromise) teardownPromise = teardown(ctx);
  await teardownPromise;

  log('main', 'done');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
