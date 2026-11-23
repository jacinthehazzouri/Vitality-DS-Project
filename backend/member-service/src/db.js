import pg from 'pg';
const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.MEMBER_DATABASE_URL });
