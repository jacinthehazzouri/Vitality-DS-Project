import pg from 'pg';
const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.BOOKING_DATABASE_URL });
