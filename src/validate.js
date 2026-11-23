import { fail } from './errors.js';

/* Input helpers: same rules and Romanian messages as everywhere in the API. */

export const mbLen = s => [...s].length;
export const mbSub = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const scalar = v => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export function str(input, key, max = 255, required = false, label = '') {
  const v = scalar(input?.[key]).trim();
  if (required && v === '') fail(422, `Completează câmpul „${label || key}”.`);
  if (mbLen(v) > max) fail(422, `Câmpul „${label || key}” este prea lung (maxim ${max} caractere).`);
  return v;
}
export function int(input, key, required = false, label = '') {
  const v = input?.[key];
  if (v === undefined || v === null || v === '') {
    if (required) fail(422, `Completează câmpul „${label || key}”.`);
    return null;
  }
  if (!/^-?\d+$/.test(String(v).trim())) fail(422, `Câmpul „${label || key}” trebuie să fie un număr.`);
  return parseInt(v, 10);
}
export function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v ? v : null;
}
export function date(input, key, required = true, label = 'Data') {
  const v = str(input, key, 10, required, label);
  if (v === '') return null;
  return validDate(v) ?? fail(422, `„${label}” nu este o dată validă.`);
}
export const isEmail = v => /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(v) && v.length <= 190;
export function isHttpUrl(v) {
  try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { return false; }
}
export const isNumeric = v => (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)));
export const toBool = v => !(v === false || v === 0 || v === '0' || v === 'false' || v === 'off' || v === '' || v === null);
