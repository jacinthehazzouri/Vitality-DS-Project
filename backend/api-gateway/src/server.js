import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const port = Number(process.env.GATEWAY_PORT || 4000);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN?.split(',') || true }));
app.get('/health', (_req, res) => res.json({ service: 'api-gateway', status: 'ok' }));
app.use('/api/admin/members', createProxyMiddleware({ target: process.env.MEMBER_SERVICE_URL || 'http://localhost:4001', changeOrigin: true, pathRewrite: path => `/admin/members${path}` }));
app.use('/api/admin/booking', createProxyMiddleware({ target: process.env.BOOKING_SERVICE_URL || 'http://localhost:4002', changeOrigin: true, pathRewrite: path => `/admin${path}` }));
app.use('/api/members', createProxyMiddleware({ target: process.env.MEMBER_SERVICE_URL || 'http://localhost:4001', changeOrigin: true, pathRewrite: path => `/members${path}` }));
app.use('/api/auth', createProxyMiddleware({ target: process.env.MEMBER_SERVICE_URL || 'http://localhost:4001', changeOrigin: true, pathRewrite: path => `/auth${path}` }));
app.use('/api/classes', createProxyMiddleware({ target: process.env.BOOKING_SERVICE_URL || 'http://localhost:4002', changeOrigin: true, pathRewrite: path => `/classes${path}` }));
app.use('/api/sessions', createProxyMiddleware({ target: process.env.BOOKING_SERVICE_URL || 'http://localhost:4002', changeOrigin: true, pathRewrite: path => `/sessions${path}` }));
app.use('/api/bookings', createProxyMiddleware({ target: process.env.BOOKING_SERVICE_URL || 'http://localhost:4002', changeOrigin: true, pathRewrite: path => `/bookings${path}` }));
app.use('/api/blockchain', createProxyMiddleware({ target: process.env.BLOCKCHAIN_SERVICE_URL || 'http://localhost:8100', changeOrigin: true, pathRewrite: path => path.replace(/^\/api\/blockchain/, '') }));
app.listen(port, () => console.log(`API Gateway listening on ${port}`));
