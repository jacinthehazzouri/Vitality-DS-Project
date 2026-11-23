import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
router.use(requireAuth, requireAdmin);

router.get('/members', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.full_name, m.email, m.is_active,
        (SELECT row_to_json(current_membership) FROM (
          SELECT id, membership_type, starts_at, expires_at, status
          FROM memberships WHERE member_id = m.id ORDER BY created_at DESC, id DESC LIMIT 1
        ) current_membership) AS membership
      FROM members m WHERE m.role = 'MEMBER' ORDER BY m.created_at DESC
    `);
    res.json({ members: rows });
  } catch (error) { next(error); }
});

function change(eventType, operation, successStatus = 200) {
  return async (req, res, next) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const member = await operation(req, client);
      if (!member) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Member or active membership not found, or no change was needed' });
      }
      const eventId = randomUUID();
      const payload = { event_id: eventId, event_type: eventType(req), actor_id: req.user.sub,
        member_reference: member.member_id || member.id, occurred_at: new Date().toISOString() };
      if (member.member_id) payload.membership_id = member.id;
      await client.query('INSERT INTO outbox_events(event_id,event_type,payload) VALUES($1,$2,$3)',
        [eventId, payload.event_type, payload]);
      await client.query('COMMIT');
      res.status(successStatus).json({ result: member, event_id: eventId, audit_status: 'PENDING' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ error: 'Email already registered' });
      next(error);
    } finally { client?.release(); }
  };
}

router.post('/members', (req, res, next) => {
  const { fullName, email, password } = req.body || {};
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 160 ||
      typeof email !== 'string' || email.trim().length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: 'Enter a valid name, email, and password (8 characters minimum, 72 bytes maximum)' });
  }
  next();
}, change(() => 'MEMBER_CREATED', async (req, db) => {
  const { fullName, email, password } = req.body;
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(`INSERT INTO members(full_name,email,password_hash)
    VALUES($1,lower($2),$3) RETURNING id,full_name,email,is_active`, [fullName.trim(), email.trim(), hash]);
  return rows[0];
}, 201));

router.param('id', (_req, res, next, id) => uuid.test(id) ? next() : res.status(400).json({ error: 'Invalid member ID' }));

router.patch('/members/:id/status', (req, res, next) => {
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  next();
}, change(req => req.body.active ? 'MEMBER_REACTIVATED' : 'MEMBER_DEACTIVATED', async (req, db) => {
  const { rows } = await db.query(`UPDATE members SET is_active=$2
    WHERE id=$1 AND role='MEMBER' AND is_active<>$2 RETURNING id,full_name,email,is_active`,
    [req.params.id, req.body.active]);
  return rows[0];
}));

export default router;
