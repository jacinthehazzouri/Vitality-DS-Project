import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.param('id', (_req, res, next, id) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid member ID' });
  }
  next();
});
router.get('/:id/membership', async (req, res, next) => {
  try {
    const internalKey = req.headers['x-internal-api-key'];
    const isInternal = Boolean(process.env.INTERNAL_API_KEY && internalKey === process.env.INTERNAL_API_KEY);
    if (!isInternal) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'Authentication required' });
      const jwt = await import('jsonwebtoken');
      let user;
      try { user = jwt.default.verify(token, process.env.JWT_SECRET); }
      catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
      if (user.role !== 'ADMIN' && user.sub !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await pool.query(`SELECT m.id, m.member_id, m.membership_type, m.starts_at, m.expires_at, m.status,
        (a.is_active AND m.status='ACTIVE' AND m.starts_at<=now() AND m.expires_at>=now()) AS is_active
      FROM memberships m JOIN members a ON a.id=m.member_id
      WHERE m.member_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 1`, [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Membership not found' });
    const { is_active, ...membership } = result.rows[0];
    res.json({ membership, is_active });
  } catch (err) { next(err); }
});
router.post('/:id/membership', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access required' });
    const { membershipType, startsAt, expiresAt } = req.body || {};
    if (!['MONTHLY','QUARTERLY','ANNUAL'].includes(membershipType) || typeof startsAt !== 'string' || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(startsAt))
      return res.status(400).json({ error: 'Valid membershipType, startsAt and expiresAt are required' });
    return await changeMembership(req, res, 'MEMBERSHIP_GRANTED', async db => {
      const { rows } = await db.query(`INSERT INTO memberships(member_id,membership_type,starts_at,expires_at,status)
        VALUES($1,$2,$3,$4,'ACTIVE') RETURNING *`, [req.params.id,membershipType,startsAt,expiresAt]);
      return rows[0];
    }, 201);
  } catch (err) { next(err); }
});
router.delete('/:id/membership', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access required' });
    return await changeMembership(req, res, 'MEMBERSHIP_REVOKED', async db => {
      const { rows } = await db.query(`UPDATE memberships SET status='CANCELLED'
        WHERE id = (SELECT id FROM memberships WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)
        AND status='ACTIVE' RETURNING *`, [req.params.id]);
      return rows[0];
    });
  } catch (error) { next(error); }
});

async function changeMembership(req, res, eventType, operation, status = 200) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid member ID' });
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const member = await db.query("SELECT id FROM members WHERE id=$1 AND role='MEMBER' AND ($2 OR is_active) FOR UPDATE",
      [req.params.id, eventType === 'MEMBERSHIP_REVOKED']);
    if (!member.rowCount) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Eligible member not found' });
    }
    const membership = await operation(db);
    if (!membership) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'No membership to revoke' });
    }
    const eventId = randomUUID();
    const event = { event_id: eventId, event_type: eventType, actor_id: req.user.sub,
      member_reference: req.params.id, membership_id: membership.id, occurred_at: new Date().toISOString() };
    await db.query('INSERT INTO outbox_events(event_id,event_type,payload) VALUES($1,$2,$3)', [eventId, eventType, event]);
    await db.query('COMMIT');
    return res.status(status).json({ membership, event_id: eventId, audit_status: 'PENDING' });
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}

export default router;
