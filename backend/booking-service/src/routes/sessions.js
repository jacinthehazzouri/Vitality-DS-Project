import { recordEvent } from './admin.js';
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.get('/', async (_req,res,next)=>{try{const r=await pool.query(`SELECT s.id,s.class_id,c.name AS class_name,s.instructor,s.starts_at,s.ends_at,s.capacity,s.capacity-(SELECT count(*) FROM bookings b WHERE b.session_id=s.id AND b.status='CONFIRMED') AS available_places FROM class_sessions s JOIN gym_classes c ON c.id=s.class_id WHERE s.starts_at>=now() AND s.cancelled_at IS NULL AND c.is_active ORDER BY s.starts_at`);res.json({sessions:r.rows});}catch(e){next(e);}});
router.post('/', requireAuth, async(req,res,next)=>{ let db; try{
  if(req.user.role!=='ADMIN') return res.status(403).json({error:'Administrator access required'});
  const {classId,instructor,startsAt,endsAt,capacity}=req.body||{};
  if (typeof classId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(classId) ||
    typeof startsAt !== 'string' || typeof endsAt !== 'string' || !Number.isFinite(Date.parse(startsAt)) ||
    !Number.isFinite(Date.parse(endsAt)) || Date.parse(startsAt) <= Date.now() || Date.parse(endsAt) <= Date.parse(startsAt) ||
    !Number.isInteger(Number(capacity)) || Number(capacity)<1 || Number(capacity)>2147483647 ||
    (instructor != null && (typeof instructor !== 'string' || instructor.length>160))) return res.status(400).json({error:'classId, valid startsAt, endsAt and positive capacity are required'});
  db = await pool.connect();
  await db.query('BEGIN');
  const activeClass = await db.query('SELECT id FROM gym_classes WHERE id=$1 AND is_active FOR UPDATE', [classId]);
  if (!activeClass.rowCount) {
    await db.query('ROLLBACK');
    return res.status(404).json({ error: 'Active class not found' });
  }
  const r=await db.query('INSERT INTO class_sessions(class_id,instructor,starts_at,ends_at,capacity) VALUES($1,$2,$3,$4,$5) RETURNING *',[classId,instructor||null,startsAt,endsAt,Number(capacity)]);
  const audit = await recordEvent(db, req, 'SESSION_SCHEDULED', { session_id: r.rows[0].id, class_id: classId });
  await db.query('COMMIT');
  res.status(201).json({session:r.rows[0], ...audit});
}catch(e){ if (db) await db.query('ROLLBACK').catch(() => {}); next(e); }
finally { db?.release(); }});
export default router;
