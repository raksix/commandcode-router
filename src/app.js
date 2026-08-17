import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyRouter } from './routes/proxy.js';
import { adminRouter } from './routes/admin.js';
import { cookieParser, requireAdmin } from './auth.js';
import { ROOT_DIR } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(cookieParser);
  app.use(express.json({ limit: '50mb' }));

  // simple request log
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  // ---- proxy API (Anthropic-compatible) ----
  app.use(proxyRouter);

  // ---- admin API ----
  app.use('/api', adminRouter);

  // ---- static admin panel assets (served directly; UI logic is protected by session on /) ----
  app.use('/assets', express.static(PUBLIC_DIR, { maxAge: '1h' }));
  // index.html is served by the login-protected route below

  app.get('/', (req, res, next) => {
    requireAdmin(req, res, () => {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  });

  return app;
}
