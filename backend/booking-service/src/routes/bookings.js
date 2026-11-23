import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.use(requireAuth);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
router.get('/me', async (req, res, next) => { try { const r = await pool.query(`SELECT b.id,b.status,b.created_at,s.starts_at,c.name AS class_name FROM bookings b JOIN class_sessions s ON s.id=b.session_id JOIN gym_classes c ON c.id=s.class_id WHERE b.member_id=$1 ORDER BY b.created_at DESC`, [req.user.sub]); res.json({ bookings: r.rows }); } catch(e) { next(e); } });
router.post('/', async (req, res, next) => {
  const { sessionId, memberId } = req.body || {};
  if (!uuid.test(sessionId || '') || (memberId !== undefined && !uuid.test(memberId || ''))) {
    return res.status(400).json({ error: 'Valid session and member IDs are required' });
  }
  if (memberId !== undefined && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Administrator access required to book for another member' });
  }
  const targetMember = memberId || req.user.sub;
  const eventType = memberId ? 'BOOKING_CREATED_BY_ADMIN' : 'BOOKING_CREATED';
  // Require an active membership before reserving a place. The Member Service remains the owner of membership data.
  try {
    const membershipResponse = await fetch(`${process.env.MEMBER_SERVICE_URL || 'http://localhost:4001'}/members/${targetMember}/membership`, { signal: AbortSignal.timeout(4000), headers: { 'x-internal-api-key': process.env.INTERNAL_API_KEY } });
    if (membershipResponse.status === 404) return res.status(403).json({ error: 'An active membership is required to book classes' });
    if (!membershipResponse.ok) return res.status(503).json({ error: 'Membership validation is temporarily unavailable' });
    const membershipData = await membershipResponse.json();
    if (!membershipData.is_active) return res.status(403).json({ error: 'Your membership is not active' });
  } catch { return res.status(503).json({ error: 'Membership validation is temporarily unavailable' }); }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const session = await client.query('SELECT id, capacity, starts_at, cancelled_at FROM class_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    if (!session.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Class session not found' }); }
    if (session.rows[0].cancelled_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This session is cancelled' }); }
    if (new Date(session.rows[0].starts_at) <= new Date()) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This session has already started' }); }
    const existing = await client.query("SELECT id FROM bookings WHERE member_id=$1 AND session_id=$2 AND status='CONFIRMED'", [targetMember, sessionId]);
    if (existing.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'You already booked this session' }); }
    const count = await client.query("SELECT count(*)::int AS total FROM bookings WHERE session_id=$1 AND status='CONFIRMED'", [sessionId]);
    if (count.rows[0].total >= session.rows[0].capacity) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Class is full' }); }
    const booking = await client.query("INSERT INTO bookings(member_id,session_id,status) VALUES($1,$2,'CONFIRMED') RETURNING id,member_id,session_id,status,created_at", [targetMember, sessionId]);
    const eventId = randomUUID();
    const payload = { event_id: eventId, event_type: eventType, actor_id: req.user.sub, booking_id: booking.rows[0].id, member_reference: targetMember, session_id: sessionId, occurred_at: new Date().toISOString() };
    await client.query("INSERT INTO outbox_events(event_id,event_type,payload) VALUES($1,$2,$3)", [eventId, eventType, payload]);
    await client.query('COMMIT');
    res.status(201).json({ booking: booking.rows[0], event_id: eventId, audit_status: 'PENDING' });
  } catch(e) { if (client) await client.query('ROLLBACK').catch(() => {}); if (e.code === '23505') return res.status(409).json({ error: 'Booking already exists' }); next(e); }
  finally { client?.release(); }
});
router.delete('/:id', async (req, res, next) => {
  if (!uuid.test(req.params.id)) return res.status(400).json({ error: 'Invalid booking ID' });
  const isAdmin = req.user.role === 'ADMIN';
  const eventType = isAdmin ? 'BOOKING_CANCELLED_BY_ADMIN' : 'BOOKING_CANCELLED';
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const r = await client.query("UPDATE bookings SET status='CANCELLED', updated_at=now() WHERE id=$1 AND (member_id=$2 OR $3) AND status='CONFIRMED' RETURNING id,member_id,session_id", [req.params.id, req.user.sub, isAdmin]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active booking not found' }); }
    const eventId = randomUUID();
    const payload = { event_id: eventId, event_type: eventType, actor_id: req.user.sub, booking_id: r.rows[0].id, member_reference: r.rows[0].member_id, session_id: r.rows[0].session_id, occurred_at: new Date().toISOString() };
    await client.query("INSERT INTO outbox_events(event_id,event_type,payload) VALUES($1,$2,$3)", [eventId,eventType,payload]);
    await client.query('COMMIT'); res.json({ message: 'Booking cancelled', event_id: eventId, audit_status: 'PENDING' });
  } catch(e) { if (client) await client.query('ROLLBACK').catch(() => {}); next(e); } finally { client?.release(); }
});
export default router;
