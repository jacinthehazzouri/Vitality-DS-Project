// Controlled local comparison. Requires pg from npm install --prefix backend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const root = process.env.VITALITY_PROJECT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.VITALITY_TEST_DEPENDENCIES || path.join(root, 'backend/booking-service'), 'package.json'));
const { Pool } = require('pg');
const config = Object.fromEntries(fs.readFileSync(path.join(root, 'backend/.env'), 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const offset = line.indexOf('='); return [line.slice(0, offset), line.slice(offset + 1).trim().replace(/^['"]|['"]$/g, '')];
  }));
function localUrl(value) { const url = new URL(value); url.hostname = 'localhost'; return url.toString(); }
const db = new Pool({ connectionString: localUrl(config.BOOKING_DATABASE_URL), connectionTimeoutMillis: 5000 });
const members = new Pool({ connectionString: localUrl(config.MEMBER_DATABASE_URL), connectionTimeoutMillis: 5000 });
const runId = new Date().toISOString();
const trials = 10;
const baselineTable = 'verification_plain_audit_' + Date.now();
let created = false;
let client;
const evidence = { runId, trials, modes: {}, events: [], limitations: [
  'Both modes run identical booking SQL. Both write to logged, persistent PostgreSQL tables.',
  'HTTP and membership validation are excluded in both modes. Members are verification accounts selected before timing.',
  'Database-only audit is complete at COMMIT. Outbox COMMIT does not include blockchain confirmation.',
  'Single laptop, ten alternating trials per mode, cold/warm cache and background work affect the measurements.',
  'Blockchain confirmation times are upper bounds observed by polling after the batch.',
] };
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean_ms: values.reduce((a, b) => a + b, 0) / values.length, p95_ms: sorted[Math.ceil(values.length * 0.95) - 1] };
}
async function call(endpoint, token, body) {
  const response = await fetch('http://localhost:4000' + endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error}`);
  return data;
}
try {
  const admin = await call('/api/auth/login', null, { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD });
  const people = (await members.query("SELECT id FROM members WHERE email LIKE 'verification.%@example.test' ORDER BY created_at LIMIT $1", [trials])).rows;
  if (people.length !== trials) throw new Error('Run verify-project.mjs to create the verification accounts first.');
  const gymClass = (await call('/api/classes', admin.token, { name: 'Audit comparison ' + runId, category: 'Verification' })).class;
  evidence.classId = gymClass.id;
  const sessions = {};
  for (const mode of ['database_audit', 'blockchain_outbox']) {
    sessions[mode] = (await call('/api/sessions', admin.token, { classId: gymClass.id, instructor: 'Benchmark', capacity: trials,
      startsAt: new Date(Date.now() + 172800000).toISOString(), endsAt: new Date(Date.now() + 176400000).toISOString() })).session.id;
  }
  evidence.sessions = sessions;
  client = await db.connect();
  await client.query(`CREATE TABLE ${baselineTable} (id BIGSERIAL PRIMARY KEY, event_id UUID NOT NULL UNIQUE,
    event_type VARCHAR(80) NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  created = true;
  const samples = { database_audit: [], blockchain_outbox: [] };
  for (let index = 0; index < trials; index++) {
    for (const mode of index % 2 ? ['blockchain_outbox', 'database_audit'] : ['database_audit', 'blockchain_outbox']) {
      const started = performance.now();
      const epoch = Date.now();
      await client.query('BEGIN');
      try {
        const sessionId = sessions[mode];
        const session = (await client.query('SELECT capacity FROM class_sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
        const existing = await client.query("SELECT id FROM bookings WHERE member_id=$1 AND session_id=$2 AND status='CONFIRMED'", [people[index].id, sessionId]);
        const count = Number((await client.query("SELECT count(*) FROM bookings WHERE session_id=$1 AND status='CONFIRMED'", [sessionId])).rows[0].count);
        if (existing.rowCount || count >= session.capacity) throw new Error('Invalid benchmark booking setup');
        const booking = (await client.query("INSERT INTO bookings(member_id,session_id,status) VALUES($1,$2,'CONFIRMED') RETURNING id", [people[index].id, sessionId])).rows[0];
        const eventId = randomUUID();
        const payload = { event_id: eventId, event_type: 'BOOKING_CREATED', booking_id: booking.id,
          member_reference: people[index].id, actor_id: people[index].id, session_id: sessionId, occurred_at: new Date().toISOString() };
        const target = mode === 'database_audit' ? baselineTable : 'outbox_events';
        await client.query(`INSERT INTO ${target}(event_id,event_type,payload) VALUES($1,'BOOKING_CREATED',$2)`, [eventId, payload]);
        await client.query('COMMIT');
        samples[mode].push(performance.now() - started);
        if (mode === 'blockchain_outbox') evidence.events.push({ event_id: eventId, started_ms: epoch });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  }
  const waiting = new Set(evidence.events.map(event => event.event_id));
  const deadline = Date.now() + 180000;
  while (waiting.size && Date.now() < deadline) {
    const ledger = await fetch('http://localhost:8100/chain', { signal: AbortSignal.timeout(15000) }).then(response => response.json());
    for (const block of ledger.blocks || []) {
      if (waiting.delete(block.event_id)) {
        const event = evidence.events.find(item => item.event_id === block.event_id);
        event.block = block.index;
        event.confirmation_upper_bound_ms = Date.now() - event.started_ms;
      }
    }
    if (waiting.size) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (waiting.size) throw new Error('Some benchmark events did not reach the chain');
  for (const [mode, times] of Object.entries(samples)) evidence.modes[mode] = { ...stats(times), samples_ms: times };
  evidence.blockchain_confirmation = stats(evidence.events.map(event => event.confirmation_upper_bound_ms));
  evidence.passed = true;
  console.log(JSON.stringify(evidence.modes));
  console.log('Blockchain confirmation', JSON.stringify(evidence.blockchain_confirmation));
} catch (error) {
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  if (created) await client.query(`DROP TABLE ${baselineTable}`);
  client?.release();
  await Promise.all([db.end(), members.end()]);
  const destination = process.env.VITALITY_BENCHMARK_RESULTS || path.join(root, 'verification-results/audit-benchmark.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(evidence, null, 2));
  console.log('Evidence saved:', destination);
}
