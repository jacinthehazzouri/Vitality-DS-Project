import bcrypt from 'bcryptjs';
import { pool } from './db.js';
const email=process.env.ADMIN_EMAIL; const password=process.env.ADMIN_PASSWORD; const fullName=process.env.ADMIN_NAME||'Vitality Administrator';
if(!email||!password||password.length<12){console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters)');process.exit(1);}
try{
 const hash=await bcrypt.hash(password,12);
 const r=await pool.query(`INSERT INTO members(full_name,email,password_hash,role) VALUES($1,lower($2),$3,'ADMIN') ON CONFLICT(email) DO UPDATE SET role='ADMIN' RETURNING id,email,role`,[fullName,email,hash]);
 console.log('Admin account ready:',r.rows[0]);
}finally{await pool.end();}
