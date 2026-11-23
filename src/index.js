import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { tableExists } from './db.js';
import { migrate } from './data.js';
import { api, sendFile } from './routes.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

/* CORS: the client (static site on another domain) may call the API. Logins travel in the
   Authorization header, never in cookies, so no credentials mode is needed. */
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;
app.use('/api', cors({
  origin: (origin, cb) => cb(null, !origin || config.clientOrigins.includes(origin) || config.clientOrigins.includes('*') || (!process.env.RENDER && localOrigin.test(origin))),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', express.json({ limit: '2mb' }));
app.get('/api/files/:id{/:name}', (req, res, next) => sendFile(req, res).catch(next));
app.use('/api', (req, res, next) => api(req, res, next).catch(next));

// local development (npm run dev) or single-server hosting: the client is served too
if (config.serveClient && fs.existsSync(config.clientDir)) {
  app.use(express.static(config.clientDir, { extensions: ['html'], index: 'index.html' }));
} else {
  app.get('/', (req, res) => res.type('text').send('API Colegiul „Mihai Viteazul” Ineu. Site-ul este pe serverul client.'));
}

// errors -> { error: "..." } with the right status, like every other API answer
app.use((err, req, res, next) => {
  let status = 500, body = { error: 'Eroare internă a serverului.' };
  if (err instanceof HttpError) { status = err.status; body = { error: err.message, ...err.extra }; }
  else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    body = { error: err.code === 'LIMIT_FILE_SIZE' ? `Un fișier este prea mare (limita: ${config.maxUploadMb} MB).` : err.code === 'LIMIT_FILE_COUNT' ? 'Prea multe fișiere odată (maxim 30).' : 'Fișierele nu s-au încărcat corect.' };
  } else if (err.type === 'entity.parse.failed') { status = 400; body = { error: 'Cerere invalidă.' }; }
  else if (err.type === 'entity.too.large') { status = 413; body = { error: 'Cererea este prea mare.' }; }
  else if (err.status === 404 && !req.path.startsWith('/api')) { status = 404; body = { error: 'Pagina nu există.' }; }
  else {
    console.error('[cmv]', err);
    if (config.debug) body.detail = err.message;
  }
  if (res.headersSent) return next(err);
  res.status(status).json(body);
});

// databases created by an older version get their new tables/columns at start-up
try { if (await tableExists('settings')) await migrate(); }
catch (e) { console.error('[cmv] Baza de date nu răspunde la pornire:', e.message); }

app.listen(config.port, config.host, () => {
  console.log(`Server CMV pornit pe portul ${config.port}`);
  if (config.serveClient) {
    console.log(`  Site:   http://localhost:${config.port}/`);
    console.log(`  Admin:  http://localhost:${config.port}/admin/`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  Din rețea (telefon): http://${n.address}:${config.port}/`);
    }
  }
});
