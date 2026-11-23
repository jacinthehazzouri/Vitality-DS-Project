import { recordEvent } from './admin.js';
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
router.get('/', async (_req, res, next) => { try { const r = await pool.query('SELECT id,name,description,category FROM gym_classes WHERE is_active=true ORDER BY name'); res.json({ classes:r.rows }); } catch(e){next(e);} });
router.post('/', requireAuth, async (req,res,next) => {
  let db;
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({error:'Administrator access required'});
    const {name,description,category}=req.body||{};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        (category != null && (typeof category !== 'string' || category.length > 80)) ||
        (description != null && typeof description !== 'string')) {
      return res.status(400).json({ error: 'Enter a valid class name, category and description' });
    }
    db = await pool.connect();
    await db.query('BEGIN');
    const r=await db.query('INSERT INTO gym_classes(name,description,category) VALUES($1,$2,$3) RETURNING *',[name.trim(),description||null,category||null]);
    const audit = await recordEvent(db, req, 'CLASS_CREATED', { class_id: r.rows[0].id });
    await db.query('COMMIT');
    res.status(201).json({class:r.rows[0], ...audit});
  } catch(e){ if (db) await db.query('ROLLBACK').catch(() => {}); next(e); }
  finally { db?.release(); }
});
export default router;
