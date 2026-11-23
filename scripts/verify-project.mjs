import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const root = process.env.VITALITY_PROJECT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyPath = process.env.VITALITY_TEST_DEPENDENCIES || path.join(root, 'backend/booking-service');
const require = createRequire(path.join(dependencyPath, 'package.json'));
const { Pool } = require('pg');
const amqp = require('amqplib');
const config = Object.fromEntries(fs.readFileSync(path.join(root, 'backend/.env'), 'utf8')
  .split(/\r?\n/).filter(line => /^\s*[A-Z_]+=/.test(line))
  .map(line => { const split = line.indexOf('='); return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const base = process.env.VITALITY_API || 'http://localhost:4000';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = process.env.VITALITY_RESULTS || path.join(root, 'verification-results', runId + '.json');
const results = { runId, started: new Date().toISOString(), tests: [], measurements: [], auditEvents: [], testRecords: {}, limitations: [] };
const outstanding = new Map();
const password = randomBytes(20).toString('base64url');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function localUrl(value) { const url = new URL(value); url.hostname = 'localhost'; return url.toString(); }
const membersDb = new Pool({ connectionString: localUrl(config.MEMBER_DATABASE_URL), connectionTimeoutMillis: 5000 });
const bookingDb = new Pool({ connectionString: localUrl(config.BOOKING_DATABASE_URL), connectionTimeoutMillis: 5000 });

function check(name, condition, observed) {
  results.tests.push({ name, passed: Boolean(condition), observed });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(observed)}`);
}
async function request(method, endpoint, token, body) {
  const started = performance.now();
  const startEpoch = Date.now();
  const response = await fetch(base + endpoint, {
    method, signal: AbortSignal.timeout(20000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (data.event_id) outstanding.set(data.event_id, startEpoch);
  return { status: response.status, data, milliseconds: performance.now() - started };
}
async function expect(name, method, endpoint, token, body, expected) {
  const response = await request(method, endpoint, token, body);
  check(name, response.status === expected, { expected, status: response.status, error: response.data.error });
  return response;
}
function needed(response, field) {
  if (response.status >= 400 || !response.data[field]) throw new Error(`Setup failed (${response.status}): ${response.data.error || field}`);
  return response.data[field];
}
async function ledger() {
  const response = await fetch('http://localhost:8100/chain', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Ledger HTTP ${response.status}`);
  return response.json();
}
async function drainAudits(label) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const chain = await ledger();
    const found = new Map(chain.blocks.map(block => [block.event_id, block]));
    for (const [id, sent] of outstanding) {
      const block = found.get(id);
      if (block) {
        results.auditEvents.push({ event_id: id, block: block.index, type: block.event_type,
          confirmation_upper_bound_ms: Date.now() - sent });
        outstanding.delete(id);
      }
    }
    if (outstanding.size === 0) {
      check(label, chain.valid, { verified: results.auditEvents.length, height: chain.height });
      return chain;
    }
    await sleep(1000);
  }
  check(label, false, { missingEvents: [...outstanding.keys()] });
  throw new Error('Audit confirmation deadline exceeded');
}
async function createMember(index) {
  const email = `verification.${runId}.${index}@example.test`;
  const created = await request('POST', '/api/admin/members', admin.token,
    { fullName: `Verification ${runId} Member ${index}`, email, password });
  const member = needed(created, 'result');
  const login = await request('POST', '/api/auth/login', null, { email, password });
  needed(login, 'token');
  return { ...member, token: login.data.token, email };
}
async function grant(member) {
  return request('POST', `/api/members/${member.id}/membership`, admin.token, {
    membershipType: 'MONTHLY', startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
}
async function createSession(classId, capacity) {
  return needed(await request('POST', '/api/sessions', admin.token, {
    classId, instructor: 'Verification Instructor', capacity,
    startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(),
  }), 'session');
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean_ms: values.reduce((a, b) => a + b, 0) / values.length,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
let admin;
let broker;
try {
  await Promise.all([membersDb.query('SELECT 1'), bookingDb.query('SELECT 1')]);
  const login = await request('POST', '/api/auth/login', null, { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD });
  needed(login, 'token');
  admin = login.data;
  if (admin.member.role !== 'ADMIN') throw new Error('Configured account is not an administrator');
  check('Admin login', true, { role: admin.member.role });
  const a = await createMember(1);
  const b = await createMember(2);
  results.testRecords.memberIds = [a.id, b.id];
  await expect('Duplicate member email', 'POST', '/api/admin/members', admin.token,
    { fullName: 'Duplicate verification', email: a.email, password }, 409);
  await expect('Anonymous admin access', 'GET', '/api/admin/members', null, undefined, 401);
  await expect('Member denied admin member list', 'GET', '/api/admin/members', a.token, undefined, 403);
  await expect('Member denied admin schedule', 'GET', '/api/admin/booking/schedule', a.token, undefined, 403);
  await expect('Member denied membership grant', 'POST', `/api/members/${a.id}/membership`, a.token, {}, 403);
  await expect('Member denied class creation', 'POST', '/api/classes', a.token, { name: 'Forbidden' }, 403);
  await expect('Member denied other membership', 'GET', `/api/members/${b.id}/membership`, a.token, undefined, 403);
  const testClass = needed(await request('POST', '/api/classes', admin.token,
    { name: `Verification ${runId}`, category: 'Verification', description: 'Automated acceptance tests' }), 'class');
  results.testRecords.classId = testClass.id;
  const single = await createSession(testClass.id, 1);
  results.testRecords.sessionId = single.id;
  await expect('Booking rejected without membership', 'POST', '/api/bookings', a.token, { sessionId: single.id }, 403);
  await expect('Invalid session dates', 'POST', '/api/sessions', admin.token,
    { classId: testClass.id, startsAt: 'invalid', endsAt: 'invalid', capacity: 1 }, 400);
  await expect('Invalid booking ID', 'DELETE', '/api/bookings/not-a-uuid', a.token, undefined, 400);
  await expect('Invalid registration shape', 'POST', '/api/auth/register', null,
    { fullName: 42, email: [], password: 'ValidPassword123' }, 400);
  await expect('Invalid membership ID', 'GET', '/api/members/not-a-uuid/membership', admin.token, undefined, 400);
  check('Grant member A membership', (await grant(a)).status === 201, {});
  check('Grant member B membership', (await grant(b)).status === 201, {});
  const race = await Promise.all([request('POST', '/api/bookings', a.token, { sessionId: single.id }),
    request('POST', '/api/bookings', b.token, { sessionId: single.id })]);
  const count = Number((await bookingDb.query("SELECT count(*) FROM bookings WHERE session_id=$1 AND status='CONFIRMED'", [single.id])).rows[0].count);
  check('Concurrent last-seat race', race.map(r => r.status).sort().join(',') === '201,409' && count === 1,
    { statuses: race.map(r => r.status), confirmedCount: count, sessionId: single.id });
  const winnerIndex = race.findIndex(r => r.status === 201);
  if (winnerIndex < 0) throw new Error('No successful race booking');
  const winner = [a, b][winnerIndex];
  const loser = [a, b][1 - winnerIndex];
  const winningBooking = race[winnerIndex].data.booking;
  const winningEvent = race[winnerIndex].data.event_id;
  const stored = (await bookingDb.query('SELECT payload,published_at FROM outbox_events WHERE event_id=$1', [winningEvent])).rows[0];
  check('Winning booking has outbox event', stored?.payload.booking_id === winningBooking.id, { eventId: winningEvent });
  await expect('Duplicate booking rejected', 'POST', '/api/bookings', winner.token, { sessionId: single.id }, 409);
  await expect('Member cannot cancel another booking', 'DELETE', `/api/bookings/${winningBooking.id}`, loser.token, undefined, 404);
  await expect('Admin cancels member booking', 'DELETE', `/api/bookings/${winningBooking.id}`, admin.token, undefined, 200);
  const rebook = await expect('Member can rebook freed seat', 'POST', '/api/bookings', loser.token, { sessionId: single.id }, 201);
  await expect('Member cancels own booking', 'DELETE', `/api/bookings/${rebook.data.booking.id}`, loser.token, undefined, 200);
  await expect('Revoke membership', 'DELETE', `/api/members/${a.id}/membership`, admin.token, undefined, 200);
  await expect('Revoked membership blocks booking', 'POST', '/api/bookings', a.token, { sessionId: single.id }, 403);
  check('Renew membership', (await grant(a)).status === 201, {});
  await expect('Deactivate member', 'PATCH', `/api/admin/members/${a.id}/status`, admin.token, { active: false }, 200);
  await expect('Inactive member cannot log in', 'POST', '/api/auth/login', null, { email: a.email, password }, 401);
  await expect('Existing token cannot book when inactive', 'POST', '/api/bookings', a.token, { sessionId: single.id }, 403);
  await expect('Reactivate member', 'PATCH', `/api/admin/members/${a.id}/status`, admin.token, { active: true }, 200);
  await expect('Reactivated member can log in', 'POST', '/api/auth/login', null, { email: a.email, password }, 200);
  await expect('Edit class', 'PATCH', `/api/admin/booking/classes/${testClass.id}`, admin.token,
    { name: `Verified ${runId}`, category: 'Verification', description: 'Updated by acceptance test' }, 200);
  await expect('Archive blocked while session upcoming', 'DELETE', `/api/admin/booking/classes/${testClass.id}`, admin.token, undefined, 409);
  await expect('Admin books on behalf of member', 'POST', '/api/bookings', admin.token,
    { sessionId: single.id, memberId: a.id }, 201);
  await expect('Cancel whole session', 'DELETE', `/api/admin/booking/sessions/${single.id}`, admin.token, undefined, 200);
  const activeAfterCancel = Number((await bookingDb.query("SELECT count(*) FROM bookings WHERE session_id=$1 AND status='CONFIRMED'", [single.id])).rows[0].count);
  check('Session cancellation cancels reservations', activeAfterCancel === 0, { confirmedCount: activeAfterCancel });
  await expect('Cancelled session rejects booking', 'POST', '/api/bookings', b.token, { sessionId: single.id }, 409);
  await expect('Archive class after session cancelled', 'DELETE', `/api/admin/booking/classes/${testClass.id}`, admin.token, undefined, 200);
  const visible = needed(await request('GET', '/api/classes'), 'classes');
  check('Archived class hidden publicly', !visible.some(item => item.id === testClass.id), {});
  await drainAudits('Acceptance events verified on blockchain');
  const beforeDuplicate = await ledger();
  const message = (await bookingDb.query('SELECT payload FROM outbox_events WHERE event_id=$1', [winningEvent])).rows[0].payload;
  broker = await amqp.connect(localUrl(config.RABBITMQ_URL));
  const channel = await broker.createConfirmChannel();
  await channel.assertQueue('vitality.audit.events', { durable: true });
  channel.sendToQueue('vitality.audit.events', Buffer.from(JSON.stringify(message)), { persistent: true, messageId: winningEvent });
  await channel.waitForConfirms();
  let duplicateSeen = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await fetch('http://localhost:8100/status').then(r => r.json());
    if (status.coordinator.last_event?.event_id === winningEvent && status.coordinator.last_event?.duplicate) { duplicateSeen = true; break; }
    await sleep(1000);
  }
  const afterDuplicate = await ledger();
  check('Live duplicate delivery acknowledged without extra block', duplicateSeen && beforeDuplicate.height === afterDuplicate.height &&
    afterDuplicate.blocks.filter(item => item.event_id === winningEvent).length === 1,
    { duplicateSeen, beforeHeight: beforeDuplicate.height, afterHeight: afterDuplicate.height, eventId: winningEvent });
  await channel.close();
  await broker.close();
  broker = null;

  if (process.env.VITALITY_SKIP_LOAD !== '1') {
  console.log('Starting API load measurements with 5, 10 and 20 concurrent members.');
  const loadMembers = [a, b];
  for (let index = 3; index <= 20; index++) {
    const member = await createMember(index);
    if ((await grant(member)).status !== 201) throw new Error('Load member membership failed');
    loadMembers.push(member);
  }
  const loadClass = needed(await request('POST', '/api/classes', admin.token,
    { name: `Load Test ${runId}`, category: 'Verification' }), 'class');
  await drainAudits('Load setup audit events recorded');
  for (const concurrency of [5, 10, 20]) {
    const session = await createSession(loadClass.id, concurrency);
    await drainAudits(`Load ${concurrency} session ready`);
    const start = performance.now();
    const replies = await Promise.all(loadMembers.slice(0, concurrency).map(member =>
      request('POST', '/api/bookings', member.token, { sessionId: session.id })));
    const wall = performance.now() - start;
    const successful = replies.filter(reply => reply.status === 201);
    const endState = Number((await bookingDb.query("SELECT count(*) FROM bookings WHERE session_id=$1 AND status='CONFIRMED'", [session.id])).rows[0].count);
    check(`Load ${concurrency} accepted without overbooking`, successful.length === concurrency && endState === concurrency,
      { successes: successful.length, confirmedCount: endState, sessionId: session.id });
    await drainAudits(`Load ${concurrency} events recorded`);
    const ids = new Set(successful.map(reply => reply.data.event_id));
    const delays = results.auditEvents.filter(event => ids.has(event.event_id)).map(event => event.confirmation_upper_bound_ms);
    const measurement = { kind: 'api_load', concurrency, successes: successful.length, requests: concurrency,
      batch_ms: wall, successful_requests_per_second: successful.length / (wall / 1000),
      ...stats(replies.map(reply => reply.milliseconds)), audit_confirmation: stats(delays) };
    results.measurements.push(measurement);
    console.log(JSON.stringify(measurement));
  }

  // Controlled comparison of the same booking SQL with two audit destinations.
  const plain = await bookingDb.connect();
  const baselineTable = 'verification_plain_audit_' + Date.now();
  let baselineCreated = false;
  try {
    await plain.query(`CREATE TABLE ${baselineTable} (
      id BIGSERIAL PRIMARY KEY, event_id UUID NOT NULL UNIQUE, event_type VARCHAR(80) NOT NULL,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    baselineCreated = true;
    const comparisons = { database_audit: [], blockchain_outbox: [] };
    const sessions = { database_audit: await createSession(loadClass.id, 10), blockchain_outbox: await createSession(loadClass.id, 10) };
    await drainAudits('Comparison setup recorded');
    for (let index = 0; index < 10; index++) {
      for (const mode of index % 2 ? ['blockchain_outbox', 'database_audit'] : ['database_audit', 'blockchain_outbox']) {
        const startEpoch = Date.now();
        const start = performance.now();
        const sessionId = sessions[mode].id;
        await plain.query('BEGIN');
        try {
          const session = (await plain.query('SELECT capacity FROM class_sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
          const existing = await plain.query("SELECT id FROM bookings WHERE member_id=$1 AND session_id=$2 AND status='CONFIRMED'", [loadMembers[index].id, sessionId]);
          const count = Number((await plain.query("SELECT count(*) FROM bookings WHERE session_id=$1 AND status='CONFIRMED'", [sessionId])).rows[0].count);
          if (existing.rowCount || count >= session.capacity) throw new Error('Invalid comparison setup');
          const booking = (await plain.query("INSERT INTO bookings(member_id,session_id,status) VALUES($1,$2,'CONFIRMED') RETURNING id", [loadMembers[index].id, sessionId])).rows[0];
          const eventId = randomUUID();
          const payload = { event_id: eventId, event_type: 'BOOKING_CREATED', booking_id: booking.id,
            member_reference: loadMembers[index].id, session_id: sessionId, actor_id: loadMembers[index].id,
            occurred_at: new Date().toISOString() };
          if (mode === 'database_audit') {
            await plain.query(`INSERT INTO ${baselineTable}(event_id,event_type,payload) VALUES($1,'BOOKING_CREATED',$2)`, [eventId, payload]);
          } else {
            await plain.query("INSERT INTO outbox_events(event_id,event_type,payload) VALUES($1,'BOOKING_CREATED',$2)", [eventId, payload]);
          }
          await plain.query('COMMIT');
          comparisons[mode].push(performance.now() - start);
          if (mode === 'blockchain_outbox') outstanding.set(eventId, startEpoch);
        } catch (error) { await plain.query('ROLLBACK'); throw error; }
      }
    }
    await drainAudits('Comparison blockchain events recorded');
    for (const [mode, durations] of Object.entries(comparisons)) {
      results.measurements.push({ kind: 'controlled_database_transaction', mode, trials: durations.length, ...stats(durations) });
    }
    results.limitations.push('Comparison uses the same booking SQL with a logged PostgreSQL audit table versus the persistent outbox. It excludes HTTP and membership validation in both modes. It is a local microbenchmark, not a production platform comparison.');
  } finally {
    if (baselineCreated) await plain.query(`DROP TABLE ${baselineTable}`);
    plain.release();
  }
  results.limitations.push('API loads are single batches of 5, 10, and 20 concurrent requests on one laptop, not a multi-host scaling experiment. Audit delays are upper bounds observed by polling, and include outbox and queue delays.');
  }
  const status = await fetch('http://localhost:8100/status').then(r => r.json());
  const hashes = new Set(status.peers.map(peer => peer.latest_hash));
  check('Final peer agreement', hashes.size === 1 && status.peers.every(peer => peer.valid), {
    peers: status.peers.map(peer => ({ peer: peer.peer, height: peer.height, valid: peer.valid, hash: peer.latest_hash })),
  });
} catch (error) {
  results.fatal = error.message;
  console.error('Verification stopped:', error.message);
  process.exitCode = 1;
} finally {
  if (broker) await broker.close().catch(() => {});
  await Promise.all([membersDb.end(), bookingDb.end()]);
  results.finished = new Date().toISOString();
  results.summary = { passed: results.tests.filter(test => test.passed).length,
    failed: results.tests.filter(test => !test.passed).length, unconfirmedEvents: [...outstanding.keys()] };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(results, null, 2));
  console.log('Results saved:', output);
  console.log(JSON.stringify(results.summary));
  if (results.summary.failed) process.exitCode = 1;
}
