import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body || {};
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 160 ||
        typeof email !== 'string' || email.trim().length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) {
      return res.status(400).json({ error: 'Enter a valid name, email and password (8 characters minimum, 72 bytes maximum)' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO members (full_name, email, password_hash) VALUES ($1, lower($2), $3) RETURNING id, full_name, email, role, created_at',
      [fullName.trim(), email.trim(), passwordHash]);
    res.status(201).json({ member: result.rows[0] });
  } catch (err) { if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' }); next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password must be strings' });
    }
    const result = await pool.query('SELECT id, full_name, email, password_hash, role FROM members WHERE email = lower($1) AND is_active', [email.trim()]);
    const member = result.rows[0];
    if (!member || !(await bcrypt.compare(password || '', member.password_hash)))
      return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ sub: member.id, role: member.role }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.json({ token, member: { id: member.id, full_name: member.full_name, email: member.email, role: member.role } });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT id, full_name, email, role, created_at FROM members WHERE id = $1 AND is_active', [req.user.sub]);
    if (!result.rowCount) return res.status(404).json({ error: 'Member not found' });
    res.json({ member: result.rows[0] });
  } catch (err) { next(err); }
});
export default router;
