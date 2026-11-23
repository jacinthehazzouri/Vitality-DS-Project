import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
router.use(requireAuth, requireAdmin);
router.param('id', (_req, res, next, id) => uuid.test(id) ? next() : res.status(400).json({ error: 'Invalid ID' }));

router.get('/schedule', async (_req, res, next) => {
  try {
    const classes = await pool.query('SELECT id,name,description,category,is_active FROM gym_classes ORDER BY name');
    const sessions = await pool.query(`
      SELECT s.id,s.class_id,c.name AS class_name,s.instructor,s.starts_at,s.ends_at,s.capacity,s.cancelled_at
      FROM class_sessions s JOIN gym_classes c ON c.id=s.class_id ORDER BY s.starts_at DESC
    `);
    res.json({ classes: classes.rows, sessions: sessions.rows });
  } catch (error) { next(error); }
});

router.get('/sessions/:id/bookings', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id,member_id,status,created_at
      FROM bookings WHERE session_id=$1 ORDER BY created_at`, [req.params.id]);
    res.json({ bookings: rows });
  } catch (error) { next(error); }
});

export async function recordEvent(db, req, eventType, references) {
  const eventId = randomUUID();
  const event = { event_id: eventId, event_type: eventType, actor_id: req.user.sub,
    occurred_at: new Date().toISOString(), ...references };
  await db.query('INSERT INTO outbox_events(event_id,event_type,payload) VALUES($1,$2,$3)',
    [eventId, eventType, event]);
  return { event_id: eventId, audit_status: 'PENDING' };
}

function write(eventType, operation) {
  return async (req, res, next) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await operation(req, client);
      if (!result) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Record not found, already changed, or has upcoming sessions' });
      }
      const { references, events = [] } = result;
      const audit = await recordEvent(client, req, eventType, references);
      for (const booking of events) {
        await recordEvent(client, req, 'BOOKING_CANCELLED_BY_ADMIN',
          { booking_id: booking.id, member_reference: booking.member_id, session_id: req.params.id });
      }
      await client.query('COMMIT');
      res.json({ ...audit, cancelled_bookings: events.length });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client?.release(); }
  };
}

router.patch('/classes/:id', (req, res, next) => {
  const { name, category, description } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
      (category != null && (typeof category !== 'string' || category.length > 80)) ||
      (description != null && typeof description !== 'string')) {
    return res.status(400).json({ error: 'Enter a valid class name, category and description' });
  }
  next();
}, write('CLASS_UPDATED', async (req, db) => {
  const { name, category, description } = req.body;
  const result = await db.query(`UPDATE gym_classes SET name=$2,category=$3,description=$4
    WHERE id=$1 AND is_active`, [req.params.id, name.trim(), category || null, description || null]);
  if (result.rowCount) return { references: { class_id: req.params.id } };
}));

router.delete('/classes/:id', write('CLASS_ARCHIVED', async (req, db) => {
  const locked = await db.query('SELECT id FROM gym_classes WHERE id=$1 AND is_active FOR UPDATE', [req.params.id]);
  if (!locked.rowCount) return;
  const result = await db.query(`UPDATE gym_classes SET is_active=false WHERE id=$1 AND NOT EXISTS (
    SELECT 1 FROM class_sessions WHERE class_id=$1 AND starts_at>now() AND cancelled_at IS NULL
  )`, [req.params.id]);
  if (result.rowCount) return { references: { class_id: req.params.id } };
}));

router.delete('/sessions/:id', write('SESSION_CANCELLED', async (req, db) => {
  const { rowCount } = await db.query(`UPDATE class_sessions SET cancelled_at=now()
    WHERE id=$1 AND cancelled_at IS NULL AND starts_at>now()`, [req.params.id]);
  if (!rowCount) return;
  const { rows } = await db.query(`UPDATE bookings SET status='CANCELLED',updated_at=now()
    WHERE session_id=$1 AND status='CONFIRMED' RETURNING id,member_id`, [req.params.id]);
  return { references: { session_id: req.params.id }, events: rows };
}));

export default router;
