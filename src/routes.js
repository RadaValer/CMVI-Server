import multer from 'multer';
import { config } from './config.js';
import { q, one, val, tx, setting, setSetting, tableExists } from './db.js';
import { fail, HttpError } from './errors.js';
import { str, int, date, validDate, isEmail, isHttpUrl, isNumeric, toBool, mbLen, mbSub } from './validate.js';
import { ROLES, publicUser, scopeUser, requireAdmin, login, logout, startSession, endUserSessions, hashPassword, checkPassword } from './auth.js';
import { ascParse, decodeXml, AscError } from './asc.js';
import { ORG_GRADS, installSchema, siteInfo, seedNews, storeTimetable } from './data.js';

/* Every call is  /api/<route>  (GET reads, POST writes); the routes and the JSON they return are
   the same as in the PHP version of the site. Routes under admin/ need an admin login made through /admin. */

// file types allowed as news attachments
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'rtf', 'zip'];
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', txt: 'text/plain; charset=utf-8', rtf: 'application/rtf', zip: 'application/zip',
};
const extOf = name => (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase() || '';
const baseName = name => mbSub(String(name).split(/[\\/]/).pop(), 255);
// the real content of an image file, whatever its name says
function isImage(buf) {
  const b = buf.subarray(0, 12);
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n' ||
    b.toString('latin1', 0, 4) === 'GIF8' || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1048576, files: 30, fields: 50, fieldSize: 1048576 },
});
const filesOf = (req, ...names) => (req.files || []).filter(f => names.includes(f.fieldname));
// multer decodes file names as latin1; browsers send UTF-8
const fileName = f => Buffer.from(f.originalname, 'latin1').toString('utf8');
const arr = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const apiBase = req => `${req.protocol}://${req.get('host')}`;

/* ===================================================================== setup */
async function setupNeeded() {
  if (!(await tableExists('users'))) return true;
  return !(await val("SELECT COUNT(*) FROM users WHERE role = 'admin'"));
}
async function doSetup(req) {
  if (!(await setupNeeded())) fail(403, 'Site-ul este deja configurat.');
  const input = req.body || {};
  const name = str(input, 'name', 120, true, 'Nume');
  const email = str(input, 'email', 190, true, 'Email').toLowerCase();
  const pass = typeof input.password === 'string' ? input.password : '';
  if (!isEmail(email)) fail(422, 'Adresa de email nu este validă.');
  checkPassword(pass);

  await installSchema();
  const hash = await hashPassword(pass);
  const id = await tx(async () => {
    const r = await q("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", [name, email, hash]);
    if (!(await val('SELECT COUNT(*) FROM news'))) await seedNews(r.insertId);
    return r.insertId;
  });
  const token = await startSession(id, 'admin');
  return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', [id])), token };
}

/* ===================================================================== news */
async function newsList(req) {
  const news = await q('SELECT id, title, body, published_on, updated_at FROM news ORDER BY published_on DESC, id DESC');
  const files = new Map();
  for (const f of await q('SELECT id, news_id, kind, path, file_id, name FROM news_files ORDER BY sort, id')) {
    // uploaded files are served by this API; the old announcements' files are part of the client (assets/)
    const url = f.file_id ? `${apiBase(req)}/api/files/${f.file_id}/${encodeURIComponent(f.name)}` : '/' + f.path.replace(/^\/+/, '');
    if (!files.has(f.news_id)) files.set(f.news_id, []);
    files.get(f.news_id).push({ id: +f.id, kind: f.kind, name: f.name, url });
  }
  return news.map(n => ({ id: +n.id, title: n.title, body: n.body, date: n.published_on, updated_at: n.updated_at, files: files.get(n.id) || [] }));
}

async function saveNews(req) {
  const admin = await requireAdmin(req);
  const input = req.body || {};
  let id = int(input, 'id');
  const title = str(input, 'title', 255, true, 'Titlu');
  const body = str(input, 'body', 60000, false, 'Text');
  const day = date(input, 'date', true, 'Data');
  const remove = [...arr(input['remove_files[]']), ...arr(input.remove_files)].map(v => parseInt(v, 10)).filter(Number.isInteger);
  if (id && !(await one('SELECT id FROM news WHERE id = ?', [id]))) fail(404, 'Noutatea nu mai există.');

  // validate every new file before touching the database
  const incoming = filesOf(req, 'files[]', 'files').map(f => {
    const name = baseName(fileName(f)), ext = extOf(name);
    const kind = IMAGE_EXT.includes(ext) ? 'image' : DOC_EXT.includes(ext) ? 'file' : null;
    if (!kind) fail(415, `Tipul fișierului „${name}” nu este permis. Sunt permise imagini (${IMAGE_EXT.join(', ')}) și documente (${DOC_EXT.join(', ')}).`);
    if (kind === 'image' && !isImage(f.buffer)) fail(415, `„${name}” nu este o imagine validă.`);
    if (!f.size) fail(400, `Fișierul „${name}” este gol.`);
    return { kind, name, mime: MIME[ext], buffer: f.buffer };
  });

  await tx(async () => {
    if (id) await q('UPDATE news SET title = ?, body = ?, published_on = ? WHERE id = ?', [title, body, day, id]);
    else id = (await q('INSERT INTO news (title, body, published_on, created_by) VALUES (?, ?, ?, ?)', [title, body, day, admin.id])).insertId;
    for (const fid of remove) {
      const row = await one('SELECT file_id FROM news_files WHERE id = ? AND news_id = ?', [fid, id]);
      if (!row) continue;
      await q('DELETE FROM news_files WHERE id = ?', [fid]);
      if (row.file_id) await q('DELETE FROM files WHERE id = ?', [row.file_id]);
    }
    let sort = +(await val('SELECT COALESCE(MAX(sort), -1) + 1 FROM news_files WHERE news_id = ?', [id]));
    for (const f of incoming) {
      const stored = await q('INSERT INTO files (mime, size, data) VALUES (?, ?, ?)', [f.mime, f.buffer.length, f.buffer]);
      await q('INSERT INTO news_files (news_id, kind, file_id, name, sort) VALUES (?, ?, ?, ?, ?)', [id, f.kind, stored.insertId, f.name, sort++]);
    }
  });
  return { ok: true, id };
}

async function deleteNews(req) {
  await requireAdmin(req);
  const id = int(req.body, 'id', true);
  await tx(async () => {
    const fileIds = (await q('SELECT file_id FROM news_files WHERE news_id = ? AND file_id IS NOT NULL', [id])).map(r => r.file_id);
    await q('DELETE FROM news WHERE id = ?', [id]);
    for (const f of fileIds) await q('DELETE FROM files WHERE id = ?', [f]);
  });
  return { ok: true };
}

/** GET /api/files/<id>/<name>: an uploaded news attachment. */
export async function sendFile(req, res) {
  const id = parseInt(req.params.id, 10);
  const f = Number.isInteger(id) && await one('SELECT f.mime, f.data, nf.name, nf.kind FROM files f LEFT JOIN news_files nf ON nf.file_id = f.id WHERE f.id = ?', [id]);
  if (!f) return res.status(404).json({ error: 'Fișierul nu există.' });
  const name = f.name || `fisier-${id}`;
  const inline = f.kind === 'image' || f.mime === 'application/pdf';
  res.set({
    'Content-Type': f.mime,
    'Content-Length': f.data.length,
    'Content-Disposition': `${inline && !('download' in req.query) ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.end(f.data);
}

/* ===================================================================== timetable */
async function timetableData() {
  const entries = {};
  for (const e of await q('SELECT class_name, day, period, subject, teachers, room, grp FROM tt_entries ORDER BY class_name, day, period, grp')) {
    (entries[e.class_name] ??= []).push([+e.day, +e.period, e.subject, e.teachers, e.room, e.grp]); // [day, period, subject, teacherCodes, room, group]
  }
  return {
    validFrom: await setting('tt_valid_from'),
    importedAt: await setting('tt_imported_at'),
    source: await setting('tt_source'),
    days: +(await setting('tt_days', '5')),
    periods: (await q('SELECT * FROM tt_periods ORDER BY period')).map(p => ({ period: +p.period, start: p.start_time, end: p.end_time })),
    classes: await q('SELECT name, level, grade FROM tt_classes ORDER BY sort, name'),
    teachers: (await q('SELECT id, code, name FROM teachers ORDER BY name')).map(t => ({ ...t, id: +t.id })),
    subjects: await q('SELECT code, name FROM tt_subjects ORDER BY name'),
    rooms: (await q('SELECT name FROM tt_rooms ORDER BY name')).map(r => r.name),
    entries,
  };
}

async function importTimetable(req) {
  await requireAdmin(req);
  const file = filesOf(req, 'file')[0];
  if (!file) fail(422, 'Alege fișierul XML exportat din aSc Orare.');
  const valid = date(req.body, 'valid_from', true, 'Valabil din');
  let tt;
  try { tt = ascParse(decodeXml(file.buffer)); } catch (e) { if (e instanceof AscError) fail(422, e.message); throw e; }
  const source = mbSub(baseName(fileName(file)), 200);

  const added = await storeTimetable(tt, valid, source);
  if (added) tt.warnings.push(`${added} profesori noi au fost adăugați în lista de profesori.`);
  const unlinked = +(await val("SELECT COUNT(*) FROM users WHERE role = 'profesor' AND teacher_code IS NOT NULL AND teacher_code NOT IN (SELECT code FROM teachers)"));
  if (unlinked) tt.warnings.push(`${unlinked} conturi de profesor au un cod care nu mai există în noul orar. Verifică-le la Utilizatori.`);
  return {
    ok: true,
    summary: { classes: tt.classes.length, teachers: tt.teachers.length, subjects: tt.subjects.length, rooms: tt.rooms.length, periods: tt.periods.length, entries: tt.entries.length, days: tt.days },
    warnings: tt.warnings,
  };
}

/* ===================================================================== substitutions */
async function getSubstitutions(req) {
  // only teachers and admins (signed in on the site, or in /admin) may see substitutions
  const u = await scopeUser(req, 'site');
  if (!(u && ['profesor', 'admin'].includes(u.role)) && !(await scopeUser(req, 'admin'))) {
    fail(u ? 403 : 401, 'Suplinirile sunt vizibile doar profesorilor. Intră în contul tău de profesor.', { code: 'teachers_only' });
  }
  const from = validDate(String(req.query.from ?? '')) ?? fail(422, 'Parametrul „from” lipsește sau nu e o dată (AAAA-LL-ZZ).');
  const to = validDate(String(req.query.to ?? from)) ?? fail(422, 'Parametrul „to” nu e o dată (AAAA-LL-ZZ).');
  if (to < from || (Date.parse(to) - Date.parse(from)) > 92 * 86400e3) fail(422, 'Intervalul cerut este invalid (maxim 3 luni).');
  const rows = await q('SELECT id, sub_date, period, class_name, absent_code, absent_name, substitute_code, substitute_name, subject, room, note FROM substitutions WHERE sub_date BETWEEN ? AND ? ORDER BY sub_date, period, class_name', [from, to]);
  return { substitutions: rows.map(({ id, sub_date, period, ...rest }) => ({ id: +id, date: sub_date, period: +period, ...rest })) };
}

async function saveSubstitutions(req) {
  const admin = await requireAdmin(req);
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) fail(422, 'Nu ai trimis nicio suplinire.');
  if (items.length > 50) fail(422, 'Poți salva cel mult 50 de supliniri odată.');
  const teacherName = Object.fromEntries((await q('SELECT code, name FROM teachers')).map(t => [t.code, t.name]));
  const clean = items.map((it, n) => {
    const row = `Rândul ${n + 1}: `;
    if (!it || typeof it !== 'object') fail(422, row + 'date invalide.');
    const s = (k, max) => mbSub(String(it[k] ?? '').trim(), max);
    const day = validDate(s('date', 10)) ?? fail(422, row + 'data lipsește sau e invalidă.');
    if (!isNumeric(it.period)) fail(422, row + 'alege ora.');
    const cls = s('class_name', 60) || fail(422, row + 'alege clasa.');
    const absentCode = s('absent_code', 30), subCode = s('substitute_code', 30);
    const absent = s('absent_name', 120) || teacherName[absentCode] || fail(422, row + 'alege profesorul absent.');
    const sub = s('substitute_name', 120) || teacherName[subCode] || fail(422, row + 'alege profesorul înlocuitor.');
    if (absentCode !== '' && absentCode === subCode) fail(422, row + 'înlocuitorul nu poate fi chiar profesorul absent.');
    const id = isNumeric(it.id) ? parseInt(it.id, 10) : null;
    return [id, day, parseInt(it.period, 10), cls, absentCode, absent, subCode, sub, s('subject', 160), s('room', 80), s('note', 255)];
  });
  const ids = await tx(async () => {
    const out = [];
    for (const [id, ...v] of clean) {
      if (id) {
        if (!(await one('SELECT id FROM substitutions WHERE id = ?', [id]))) fail(404, 'Una dintre supliniri nu mai există.');
        await q('UPDATE substitutions SET sub_date=?, period=?, class_name=?, absent_code=?, absent_name=?, substitute_code=?, substitute_name=?, subject=?, room=?, note=? WHERE id=?', [...v, id]);
        out.push(id);
      } else {
        out.push((await q('INSERT INTO substitutions (sub_date, period, class_name, absent_code, absent_name, substitute_code, substitute_name, subject, room, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [...v, admin.id])).insertId);
      }
    }
    return out;
  });
  return { ok: true, ids };
}

async function deleteSubstitution(req) {
  await requireAdmin(req);
  await q('DELETE FROM substitutions WHERE id = ?', [int(req.body, 'id', true)]);
  return { ok: true };
}

/* ===================================================================== users */
async function saveUser(req) {
  const admin = await requireAdmin(req);
  const input = req.body || {};
  let id = int(input, 'id');
  const name = str(input, 'name', 120, true, 'Nume');
  const email = str(input, 'email', 190, true, 'Email').toLowerCase();
  const role = str(input, 'role', 20, true, 'Rol');
  const pass = typeof input.password === 'string' ? input.password : '';
  const active = toBool(input.active ?? true) ? 1 : 0;
  if (!isEmail(email)) fail(422, 'Adresa de email nu este validă.');
  if (!ROLES.includes(role)) fail(422, 'Rol necunoscut.');
  const cls = role === 'elev' ? str(input, 'class_name', 60) || null : null;
  const code = role === 'profesor' ? str(input, 'teacher_code', 30) || null : null;
  if (!id || pass !== '') checkPassword(pass);

  if (await one('SELECT id FROM users WHERE email = ? AND id <> ?', [email, id ?? 0])) fail(409, 'Există deja un cont cu acest email.');

  if (id) {
    const old = await one('SELECT * FROM users WHERE id = ?', [id]) || fail(404, 'Utilizatorul nu mai există.');
    if (id === +admin.id && (role !== 'admin' || !active)) fail(422, 'Nu îți poți scoate singur rolul de admin sau dezactiva propriul cont.');
    const sets = ['name=?', 'email=?', 'role=?', 'class_name=?', 'teacher_code=?', 'active=?'], args = [name, email, role, cls, code, active];
    if (pass !== '') { sets.push('password_hash=?'); args.push(await hashPassword(pass)); }
    await q(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
    // a new password, a deactivated account or a lost admin role signs the user out everywhere else
    if (pass !== '' || !active || (old.role === 'admin' && role !== 'admin')) await endUserSessions(id, id === +admin.id ? req : null);
  } else {
    id = (await q('INSERT INTO users (name, email, password_hash, role, class_name, teacher_code, active) VALUES (?, ?, ?, ?, ?, ?, ?)', [name, email, await hashPassword(pass), role, cls, code, active])).insertId;
  }
  return { user: publicUser(await one('SELECT * FROM users WHERE id = ?', [id])) };
}

async function deleteUser(req) {
  const admin = await requireAdmin(req);
  const id = int(req.body, 'id', true);
  if (id === +admin.id) fail(422, 'Nu îți poți șterge propriul cont.');
  await q('DELETE FROM users WHERE id = ?', [id]);
  return { ok: true };
}

/* ===================================================================== contact & organisation */
async function saveSite(req) {
  await requireAdmin(req);
  const input = req.body || {};
  const s = input.school && typeof input.school === 'object' ? input.school : fail(422, 'Date de contact lipsă.');
  const txt = (v, max, label, required = false) => {
    v = ['string', 'number'].includes(typeof v) ? String(v).trim() : '';
    if (required && v === '') fail(422, `Completează câmpul „${label}”.`);
    if (mbLen(v) > max) fail(422, `„${label}” este prea lung (maxim ${max} caractere).`);
    return v;
  };
  const email = (v, label) => { v = txt(v, 190, label); if (v !== '' && !isEmail(v)) fail(422, `„${label}” nu este o adresă de email validă.`); return v; };
  const url = (v, label) => { v = txt(v, 300, label); if (v !== '' && !isHttpUrl(v)) fail(422, `Linkul de ${label} trebuie să înceapă cu https:// (sau lasă câmpul gol).`); return v; };
  const num = (v, min, max, label) => { if (!isNumeric(v) || +v < min || +v > max) fail(422, `„${label}” trebuie să fie un număr între ${min} și ${max}.`); return +v; };
  const social = s.social && typeof s.social === 'object' ? s.social : {};
  const map = s.map && typeof s.map === 'object' ? s.map : {};
  const school = {
    name: txt(s.name, 160, 'Numele școlii', true),
    emailSchool: email(s.emailSchool, 'Email școală'),
    emailAdmin: email(s.emailAdmin, 'Email administrație'),
    emailWebmaster: email(s.emailWebmaster, 'Email administrator'),
    phone: txt(s.phone, 60, 'Telefon'),
    address: txt(s.address, 255, 'Adresa'),
    social: { facebook: url(social.facebook, 'Facebook'), instagram: url(social.instagram, 'Instagram'), youtube: url(social.youtube, 'YouTube') },
    map: { lat: num(map.lat, -90, 90, 'Latitudine'), lng: num(map.lng, -180, 180, 'Longitudine'), zoom: Math.trunc(num(map.zoom, 1, 21, 'Zoom')) },
  };

  const orgIn = input.organization ?? [];
  if (!Array.isArray(orgIn) || orgIn.length > 20) fail(422, 'Organizarea poate avea cel mult 20 de funcții.');
  const org = orgIn.map((g, i) => {
    const role = txt(g?.role, 80, `Funcția ${i + 1}`, true);
    const people = (Array.isArray(g?.people) ? g.people : []).map(p => txt(p, 120, `Persoană la ${role}`)).filter(Boolean);
    if (!people.length) fail(422, `Adaugă cel puțin o persoană la „${role}”.`);
    if (people.length > 30) fail(422, `Prea multe persoane la „${role}”.`);
    return { role, people, grad: Math.max(0, parseInt(g?.grad, 10) || 0) % ORG_GRADS.length };
  });

  await tx(async () => {
    await setSetting('school', JSON.stringify(school));
    await setSetting('organization', JSON.stringify(org));
  });
  return siteInfo();
}

/* ===================================================================== "Altele" menu links */
async function saveLinks(req) {
  await requireAdmin(req);
  const input = req.body?.links;
  if (!Array.isArray(input) || input.length > 30) fail(422, 'Meniul „Altele” poate avea cel mult 30 de linkuri.');
  const links = input.map((l, i) => {
    const title = typeof l?.title === 'string' ? l.title.trim() : '';
    const url = typeof l?.url === 'string' ? l.url.trim() : '';
    const n = i + 1;
    if (title === '') fail(422, `Completează titlul la linkul ${n}.`);
    if (mbLen(title) > 80) fail(422, `Titlul linkului ${n} este prea lung (maxim 80 de caractere).`);
    if (url === '' || mbLen(url) > 500 || !isHttpUrl(url)) fail(422, `Linkul „${title}” trebuie să fie o adresă completă care începe cu https://.`);
    return { title, url };
  });
  await setSetting('links', JSON.stringify(links));
  return siteInfo();
}

/* ===================================================================== teachers */
async function saveTeacher(req) {
  await requireAdmin(req);
  const input = req.body || {};
  const id = int(input, 'id');
  const name = str(input, 'name', 120, true, 'Nume');
  const code = str(input, 'code', 30, true, 'Cod');
  if (!/^[\p{L}\p{N}._-]+$/u.test(code)) fail(422, 'Codul poate conține doar litere, cifre, punct, cratimă sau liniuță jos (fără spații sau virgule).');
  if (await one('SELECT id FROM teachers WHERE code = ? AND id <> ?', [code, id ?? 0])) fail(409, `Codul „${code}” este deja folosit de alt profesor.`);

  if (!id) return { ok: true, id: (await q('INSERT INTO teachers (code, name) VALUES (?, ?)', [code, name])).insertId };
  const old = await one('SELECT * FROM teachers WHERE id = ?', [id]) || fail(404, 'Profesorul nu mai există.');
  await tx(async () => {
    await q('UPDATE teachers SET code = ?, name = ? WHERE id = ?', [code, name, id]);
    if (old.code === code) return;
    // a new code is carried over everywhere the old one was used
    await q('UPDATE users SET teacher_code = ? WHERE teacher_code = ?', [code, old.code]);
    await q('UPDATE substitutions SET absent_code = ? WHERE absent_code = ?', [code, old.code]);
    await q('UPDATE substitutions SET substitute_code = ? WHERE substitute_code = ?', [code, old.code]);
    for (const e of await q('SELECT id, teachers FROM tt_entries WHERE FIND_IN_SET(?, teachers)', [old.code])) {
      await q('UPDATE tt_entries SET teachers = ? WHERE id = ?', [e.teachers.split(',').map(c => (c === old.code ? code : c)).join(','), e.id]);
    }
  });
  return { ok: true, id };
}

async function deleteTeacher(req) {
  await requireAdmin(req);
  const t = await one('SELECT * FROM teachers WHERE id = ?', [int(req.body, 'id', true)]) || fail(404, 'Profesorul nu mai există.');
  await tx(async () => {
    await q('DELETE FROM teachers WHERE id = ?', [t.id]);
    await q('UPDATE users SET teacher_code = NULL WHERE teacher_code = ?', [t.code]);
  });
  return { ok: true };
}

/* ===================================================================== routing */
const ROUTES = {
  // setup (first run)
  'GET setup': async () => ({ needed: await setupNeeded() }),
  'POST setup': doSetup,

  // public site
  'GET site': () => siteInfo(),
  'GET news': async req => ({ news: await newsList(req) }),
  'GET timetable': () => timetableData(),
  'GET substitutions': getSubstitutions,
  'GET me': async req => { const u = await scopeUser(req, 'site'); return { user: u ? publicUser(u) : null }; },
  'POST login': req => login(req, 'site'),
  'POST logout': async req => { await logout(req, 'site'); return { ok: true }; },

  // admin
  'GET admin/me': async req => { const u = await scopeUser(req, 'admin'); return { user: u ? publicUser(u) : null }; },
  'POST admin/login': req => login(req, 'admin'),
  'POST admin/logout': async req => { await logout(req, 'admin'); return { ok: true }; },
  'POST admin/news/save': saveNews,
  'POST admin/news/delete': deleteNews,
  'POST admin/timetable/import': importTimetable,
  'POST admin/subs/save': saveSubstitutions,
  'POST admin/subs/delete': deleteSubstitution,
  'GET admin/users': async req => { await requireAdmin(req); return { users: (await q('SELECT * FROM users ORDER BY role, name')).map(publicUser) }; },
  'POST admin/users/save': saveUser,
  'POST admin/users/delete': deleteUser,
  'POST admin/site/save': saveSite,
  'POST admin/links/save': saveLinks,
  'POST admin/teachers/save': saveTeacher,
  'POST admin/teachers/delete': deleteTeacher,
};
// routes that upload files (multipart/form-data)
const MULTIPART = new Set(['POST admin/news/save', 'POST admin/timetable/import']);
const uploadAny = upload.any();

let installed = false;
/** Express handler for everything under /api/. */
export async function api(req, res, next) {
  const route = req.path.replace(/^\/+|\/+$/g, '');
  const key = `${req.method} ${route}`;
  const handler = ROUTES[key];
  if (!handler) {
    const known = Object.keys(ROUTES).some(k => k.split(' ')[1] === route);
    return next(new HttpError(known ? 405 : 404, known ? 'Metodă nepermisă.' : 'Rută necunoscută.'));
  }
  if (MULTIPART.has(key) && req.is('multipart/form-data')) {
    await new Promise((resolve, reject) => uploadAny(req, res, err => (err ? reject(err) : resolve())));
  }
  if (route !== 'setup' && !installed) {
    if (!(await tableExists('settings'))) fail(503, 'Site-ul nu a fost încă configurat. Deschide /admin pentru configurarea inițială.', { code: 'not_installed' });
    installed = true;
  }
  res.set('Cache-Control', 'no-store');
  res.json(await handler(req));
}
