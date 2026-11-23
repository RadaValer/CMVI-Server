import fs from 'node:fs';
import path from 'node:path';
import { SERVER_DIR } from './config.js';
import { q, raw, val, tx, setting, setSetting, tableExists } from './db.js';

// colour bars of the "Organizare" cards; stored as an index so no CSS ever comes from the database
export const ORG_GRADS = [
  'linear-gradient(100deg,#8070b0,#5f7f9f)',
  'linear-gradient(100deg,#4f7a9d,#55a09a)',
  'linear-gradient(100deg,#5a62ac,#559a7a)',
  'linear-gradient(100deg,#4f8d93,#4a72a0)',
  'linear-gradient(100deg,#557fb0,#458a80)',
  'linear-gradient(100deg,#a678b8,#5f76b0)',
];

// the school's details as they were on the old site
export const DEFAULT_SCHOOL = {
  name: 'Colegiul "Mihai Viteazul" Ineu',
  emailSchool: 'gsmv.ineu@yahoo.com',
  emailAdmin: 'gsmv.ineu@gmail.com',
  emailWebmaster: 'secretariat@lmvineu.ro',
  phone: '(+40) 257511777',
  address: 'Calea Traian Nr. 7, 315300, Ineu, jud. Arad, Romania',
  social: { facebook: '', instagram: '', youtube: '' },
  map: { lat: 46.428118548566, lng: 21.838524341583, zoom: 17 },
};
// the management team from the old site's "Organizare" page
export const DEFAULT_ORGANIZATION = [
  { role: 'Director', people: ['Prof. Liliana-Dana NEMEȘ'], grad: 0 },
  { role: 'Director adjunct', people: ['Prof. Veniamin IGA', 'Prof. Cristina PREDA', 'Prof. Ciprian MANGUCI'], grad: 1 },
  { role: 'Contabil', people: ['ec. Dana MIHALACHE'], grad: 2 },
];
// external links of the "Altele" menu, as they were on the old site
export const DEFAULT_LINKS = [
  { title: 'Oferta educațională', url: 'https://sites.google.com/lmvineu.ro/oferta-educationala-cmv' },
  { title: 'Învățământ dual', url: 'https://sites.google.com/lmvineu.ro/inv-dual-cmv/acas%C4%83' },
  { title: 'Proiecte europene', url: 'https://sites.google.com/lmvineu.ro/european-projects/home' },
  { title: 'Înscriere clasa pregătitoare', url: 'https://sites.google.com/lmvineu.ro/inscriere-clasa0/home' },
  { title: 'Smartlab CMV', url: 'https://sites.google.com/lmvineu.ro/smartlab/home' },
  { title: 'PEO Primul student', url: 'https://sites.google.com/lmvineu.ro/documente-cmv/peo_primul-student' },
];

/** Creates the missing tables, upgrades older databases and writes the default content once. */
export async function installSchema() {
  const schema = fs.readFileSync(path.join(SERVER_DIR, 'schema.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
  for (const stmt of schema.split(';')) if (stmt.trim()) await raw(stmt);
  await migrate();
  // contact details, organisation and links are only written when missing, so edits made in /admin stay
  if (await setting('school') === null) await setSetting('school', JSON.stringify(DEFAULT_SCHOOL));
  if (await setting('organization') === null) await setSetting('organization', JSON.stringify(DEFAULT_ORGANIZATION));
}

/** Databases made by the older (PHP) version of the site: news_files had no file_id column. */
export async function migrate() {
  if (!(await tableExists('news_files'))) return;
  const hasCol = await val("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'news_files' AND column_name = 'file_id'");
  if (!hasCol) {
    await raw('ALTER TABLE news_files ADD COLUMN file_id INT UNSIGNED NULL AFTER path');
    await raw("ALTER TABLE news_files MODIFY path VARCHAR(255) NOT NULL DEFAULT ''");
  }
  for (const t of ['sessions', 'files']) {
    if (!(await tableExists(t))) {
      const schema = fs.readFileSync(path.join(SERVER_DIR, 'schema.sql'), 'utf8').replace(/^\s*--.*$/gm, '');
      const stmt = schema.split(';').find(s => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(s));
      if (stmt) await raw(stmt);
    }
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}
const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };

export async function siteInfo() {
  const stored = parseJson(await setting('school', '{}'));
  const school = deepMerge(DEFAULT_SCHOOL, isObj(stored) ? stored : {});
  let org = parseJson(await setting('organization', 'null'));
  if (!Array.isArray(org)) org = DEFAULT_ORGANIZATION;
  let links = parseJson(await setting('links', 'null'));
  if (!Array.isArray(links)) links = DEFAULT_LINKS;
  return {
    school,
    links,
    organization: org.map(g => ({ role: g.role, people: g.people, grad: +g.grad || 0, css: ORG_GRADS[(+g.grad || 0) % ORG_GRADS.length] })),
    grads: ORG_GRADS,
  };
}

// the announcements that were hard-coded in the old site
export async function seedNews(by) {
  const items = [
    ['2025-08-17', 'ANUNŢ ÎNSCRIERE LA CLASA a IX-a, AN ŞCOLAR 2025/2026', 'DEPUNERE DOSARE:\n\nJOI – 24.07.2025 DE LA 09:00-14:00;\nVINERI - 25.07.2025 DE LA 09:00-14:00;\nLUNI - 28.07.2025 DE LA 09:00-14:00 ;\nMIERCURI -  29.07.2025 DE LA ORA 09:00-14:00.\n\nDocumente necesare:\n- FOAIA MATRICOLĂ CLS. V-VIII;\n- ADEVERINŢĂ NOTE EVALUARE NAŢIONALĂ;\n- COPIE+ORIGINAL -CERTIFICAT NAŞTERE ELEV;\n- COPIE+ORIGINAL-CARTE DE IDENTITATE ELEV;\n- COPIE+ORIGINAL-CARTE DE IDENTITATE AMBII PĂRINŢI;\n- SENTINŢĂ JUDECĂTOREASCĂ DACĂ ESTE CAZUL;\n- ADEVERINŢĂ MEDICALĂ CU VACCINURILE DE LA MEDICUL DE FAMILIE PENTRU CEI CARE VIN DIN ALTE ŞCOLI;\n- BILETUL CU CODUL CANDIDATULUI.\n\nDIRECTOR,\nProf. NEMEŞ LILIANA DANA', []],
    ['2025-06-19', 'Contestațiile din sesiunea de bacalaureat iunie 2025', 'Contestațiile din sesiunea de bacalaureat iunie 2025 se depun în centrul de examen astfel:\nData 20.06.2025\n1. între orele 14.00-17.00 se depun cereri vizualizare lucrări.\n2. între orele 17.00-18.00 vizualizare lucrări și depunere contestație.\nData 23.06.2025-24.06.2025\n1. între orele 9.00-17.00 vizualizare lucrări și depunere contestație.\nAcestea pot fi depuse și online pe adresa de email contestatiebacineu2025@gmail.com. În acest caz acestea vor fi însoțite și de copia cărții de identitate.\nNOTA ACORDATĂ CONFORM SOLUȚIONĂRII CONTESTAȚIEI POATE MODIFICA, DUPĂ CAZ, NOTA INIȚIALĂ PRIN CREȘTERE SAU DESCREȘTERE ȘI REPREZINTĂ NOTA FINALĂ OBȚINUTĂ LA PROBA RESPECTIVĂ CARE NU MAI POATE FI MODIFICATĂ.', []],
    ['2025-06-13', 'Anunț vizualizare lucrări și contestații bacalaureat', '', [['image', 'assets/doc-1.jpg', 'Anunț etapă vizualizare lucrări și depunere contestații.jpg'], ['image', 'assets/doc-2.png', 'Programarea candidaților.png']]],
  ];
  for (const [date, title, body, files] of items) {
    const r = await q('INSERT INTO news (title, body, published_on, created_by) VALUES (?, ?, ?, ?)', [title, body, date, by]);
    for (const [i, [kind, p, name]] of files.entries()) {
      await q('INSERT INTO news_files (news_id, kind, path, name, sort) VALUES (?, ?, ?, ?, ?)', [r.insertId, kind, p, name, i]);
    }
  }
}

/** Adds teachers that are not in the table yet; existing ones keep the name set in /admin. */
export async function upsertTeachers(teachers) {
  let added = 0;
  for (const t of teachers) added += (await q('INSERT IGNORE INTO teachers (code, name) VALUES (?, ?)', [t.code, t.name])).affectedRows;
  return added;
}

/** Replaces the whole timetable (as parsed by ascParse or built by the populate script). */
export function storeTimetable(tt, validFrom, source) {
  return tx(async () => {
    for (const t of ['tt_entries', 'tt_periods', 'tt_classes', 'tt_subjects', 'tt_rooms']) await q(`DELETE FROM ${t}`);
    const bulk = async (table, cols, rows) => {
      if (!rows.length) return;
      for (let i = 0; i < rows.length; i += 300) {
        const chunk = rows.slice(i, i + 300);
        await raw(`INSERT INTO ${table} (${cols.join(',')}) VALUES ?`, [chunk]);
      }
    };
    await bulk('tt_periods', ['period', 'start_time', 'end_time'], tt.periods.map(p => [p.period, p.start, p.end]));
    await bulk('tt_classes', ['name', 'level', 'grade', 'sort'], tt.classes.map(c => [c.name, c.level, c.grade, c.sort]));
    await bulk('tt_subjects', ['code', 'name'], tt.subjects.map(s => [s.code, s.name]));
    await bulk('tt_rooms', ['name'], tt.rooms.map(r => [r]));
    await bulk('tt_entries', ['class_name', 'day', 'period', 'subject', 'teachers', 'room', 'grp'], tt.entries.map(e => [e.class, e.day, e.period, e.subject, e.teachers, e.room, e.grp]));
    const added = await upsertTeachers(tt.teachers);
    await setSetting('tt_valid_from', validFrom);
    await setSetting('tt_imported_at', new Date().toISOString().replace(/\.\d+Z$/, '+00:00'));
    await setSetting('tt_source', source);
    await setSetting('tt_days', String(tt.days));
    return added;
  });
}
