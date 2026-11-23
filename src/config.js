/* All settings come from environment variables (on Render: Environment tab).
   Locally they can also be written in server/.env (see .env.example). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(SERVER_DIR, '.env')); } catch { /* no .env: fine */ }

const env = (...names) => {
  for (const n of names) { const v = process.env[n]; if (v !== undefined && v !== '') return v; }
  return undefined;
};

// the database: DATABASE_URL (mysql://user:pass@host:port/name), DB_* or the MYSQL_ADDON_* names of Clever Cloud
function dbConfig() {
  const url = env('DATABASE_URL', 'MYSQL_ADDON_URI');
  if (url) {
    const u = new URL(url);
    return { host: u.hostname, port: +(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') };
  }
  return {
    host: env('DB_HOST', 'MYSQL_ADDON_HOST') || '127.0.0.1',
    port: +(env('DB_PORT', 'MYSQL_ADDON_PORT') || 3306),
    user: env('DB_USER', 'MYSQL_ADDON_USER') || 'cmv',
    password: env('DB_PASSWORD', 'DB_PASS', 'MYSQL_ADDON_PASSWORD') || '',
    database: env('DB_NAME', 'MYSQL_ADDON_DB') || 'cmv',
  };
}

export const config = {
  port: +(env('PORT') || 5173),
  host: env('HOST') || '0.0.0.0',
  db: dbConfig(),
  dbPool: Math.max(1, +(env('DB_POOL') || 4)),
  // addresses of the client (the static site) that may call this API, comma separated
  clientOrigins: (env('CLIENT_ORIGIN') || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
  // number of reverse proxies in front of the server (Render: 1), so the visitor's IP is seen
  trustProxy: +(env('TRUST_PROXY') || 0),
  maxUploadMb: +(env('MAX_UPLOAD_MB') || 10),
  debug: env('DEBUG') === '1',
  // serve the client folder too (local development / single-server hosting)
  serveClient: process.argv.includes('--serve-client') || env('SERVE_CLIENT') === '1',
  clientDir: path.resolve(SERVER_DIR, env('CLIENT_DIR') || '../client'),
};
