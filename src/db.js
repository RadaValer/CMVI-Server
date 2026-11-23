import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import { HttpError } from './errors.js';

export const pool = mysql.createPool({
  ...config.db,
  charset: 'utf8mb4',
  dateStrings: true,        // DATE / DATETIME stay plain strings ("2025-06-13"), as the client expects
  timezone: 'Z',
  // Clever Cloud's smallest MySQL plans allow only a few connections at once
  connectionLimit: config.dbPool,
  waitForConnections: true,
  enableKeepAlive: true,
});
pool.pool.on('connection', conn => conn.query("SET time_zone = '+00:00'"));

// inside tx() every q() runs on the transaction's connection
const txStore = new AsyncLocalStorage();

/** Runs a query; returns the rows for SELECT, the result header (insertId, affectedRows) otherwise. */
export async function q(sql, args = []) {
  const conn = txStore.getStore() || pool;
  try {
    const [rows] = await conn.execute(sql, args.map(v => (v === undefined ? null : v)));
    return rows;
  } catch (e) {
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'PROTOCOL_CONNECTION_LOST'].includes(e.code)) {
      console.error('[cmv] DB:', e.message);
      throw new HttpError(503, 'Nu mă pot conecta la baza de date. Verifică variabilele DB_* ale serverului.');
    }
    throw e;
  }
}
/** Plain query (no prepared statement), for DDL and multi-row inserts. */
export async function raw(sql, args = []) {
  const conn = txStore.getStore() || pool;
  const [rows] = await conn.query(sql, args);
  return rows;
}
export const one = async (sql, args) => (await q(sql, args))[0] || null;
export const val = async (sql, args) => { const r = await one(sql, args); return r ? Object.values(r)[0] : null; };

export async function tx(fn) {
  if (txStore.getStore()) return fn(); // already inside one
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await txStore.run(conn, fn);
    await conn.commit();
    return r;
  } catch (e) {
    try { await conn.rollback(); } catch { /* connection lost */ }
    throw e;
  } finally {
    conn.release();
  }
}

export async function setting(k, def = null) {
  const r = await one('SELECT v FROM settings WHERE k = ?', [k]);
  return r ? r.v : def;
}
export async function setSetting(k, v) {
  await q('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
}
export async function tableExists(name) {
  return !!(await val('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]));
}
