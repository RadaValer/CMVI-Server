/*
  Populează baza de date cu date DEMONSTRATIVE, pentru teste:
    - creează tabelele (dacă lipsesc) și datele de contact + organizarea reale (doar dacă lipsesc)
    - noutățile vechi ale site-ului (doar dacă nu există nicio noutate)
    - profesori, orar pentru toate clasele (Primar 0–IV, Gimnaziu V–VIII, Liceu IX–XII)
    - supliniri pentru săptămâna trecută, cea curentă și următoarea
    - conturi de test: un elev și un profesor (+ un admin, doar dacă nu există niciunul)

  ATENȚIE: înlocuiește orarul și suplinirile existente. Nu îl rula pe site-ul public cu date reale.

  Rulare (din folderul server):   npm run populate
*/
import { config } from '../src/config.js';
import { pool, q, val, one } from '../src/db.js';
import { installSchema, seedNews, storeTimetable } from '../src/data.js';
import { hashPassword } from '../src/auth.js';

if (!process.argv.includes('--yes')) {
  console.log('Acest script înlocuiește ORARUL și SUPLINIRILE din baza de date cu date demonstrative.');
  console.log('Datele de contact, organizarea, noutățile și conturile existente rămân neschimbate.');
  console.log('Rulează din nou cu --yes ca să continui:  node scripts/populate.js --yes');
  process.exit(0);
}

// the same pseudo-random sequence on every run, so the demo timetable is always the same
let seed = 2025;
const rnd = (min, max) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return min + (((t ^ (t >>> 14)) >>> 0) % (max - min + 1)); };
const crc32 = s => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const ymd = d => d.toISOString().slice(0, 10);

try {
  console.log(`Baza de date: ${config.db.database} @ ${config.db.host}`);
  await installSchema();
  console.log('✓ tabele, date de contact și organizare');
  if (!(await val('SELECT COUNT(*) FROM news'))) { await seedNews(null); console.log('✓ noutăți (anunțurile vechi ale site-ului)'); }

  /* ---------- teachers, subjects, rooms ---------- */
  const teachers = [
    ['AF', 'Alda Florin Alexandru'], ['ANR', 'Alda Natalia Rodica'], ['MDA', 'Andreea Diana Murariu'], ['FeA', 'Antonie Feher'],
    ['AM', 'Ardelean Maria'], ['BL', 'Bogdan Lucian'], ['CrM', 'Crișan Mihaela'], ['DR', 'Dragoș Radu'],
    ['GA', 'Gavrilă Adina'], ['LI', 'Lazăr Irina'], ['MS', 'Mureșan Sorin'], ['PD', 'Pop Daniel'],
    ['RS', 'Rusu Simona'], ['SE', 'Stan Elena'], ['TI', 'Toma Ioana'], ['VC', 'Vlad Cristian'],
    ['CA', 'Cozma Alina'], ['HM', 'Hărășim Marius'], ['NO', 'Nistor Oana'], ['PV', 'Popa Victor'],
    ['SB', 'Sabău Bianca'], ['TC', 'Tripon Călin'], ['UL', 'Ursu Laura'], ['ZG', 'Zăvoianu Gheorghe'],
  ];
  const subjects = {
    Rom: 'Limba și literatura română', Mat: 'Matematică', Eng: 'Limba engleză', Fra: 'Limba franceză',
    Geo: 'Geografie', Chm: 'Chimie', Eda: 'Educație antreprenorială', Fiz: 'Fizică', Bio: 'Biologie',
    Ist: 'Istorie', Inf: 'Informatică', Efs: 'Educație fizică', Tic: 'TIC', Muz: 'Muzică', Rel: 'Religie',
    Clr: 'Comunicare în limba română', Mem: 'Matematică și explorarea mediului', Avp: 'Arte vizuale', Dp: 'Dezvoltare personală',
  };
  const rooms = ['Sala 4', 'Sala 7', 'Sala 12', 'Sala 15', 'Sala 21', 'Lab. informatică', 'Lab. chimie', 'Sala de sport'];
  const specialRoom = { Inf: 'Lab. informatică', Tic: 'Lab. informatică', Chm: 'Lab. chimie', Efs: 'Sala de sport' };
  // several teachers per subject, so classes are spread between them
  const bySubject = {
    Rom: ['AM', 'NO'], Mat: ['PD', 'PV'], Eng: ['BL', 'UL'], Fra: ['GA'], Geo: ['RS'], Chm: ['MS'],
    Eda: ['CrM'], Fiz: ['VC', 'HM'], Bio: ['TI'], Ist: ['SE', 'ZG'], Inf: ['DR', 'AF'], Tic: ['AF'],
    Efs: ['LI', 'TC'], Muz: ['ANR'], Rel: ['MDA'],
  };
  const levels = [
    ['primar', ['0', 'I', 'II', 'III', 'IV'], ['A', 'B', 'C'], 4, ['Clr', 'Clr', 'Mem', 'Mem', 'Avp', 'Dp', 'Muz', 'Eng', 'Rel', 'Efs']],
    ['gimnaziu', ['V', 'VI', 'VII', 'VIII'], ['A', 'B'], 5, ['Rom', 'Rom', 'Mat', 'Mat', 'Eng', 'Fra', 'Geo', 'Ist', 'Bio', 'Fiz', 'Tic', 'Efs', 'Muz', 'Rel']],
    ['liceu', ['IX', 'X', 'XI', 'XII'], ['A', 'B', 'C', 'D'], 6, ['Rom', 'Rom', 'Mat', 'Mat', 'Eng', 'Fra', 'Geo', 'Chm', 'Eda', 'Fiz', 'Bio', 'Ist', 'Inf', 'Efs']],
  ];
  // primary classes are taught by their own teacher ("învățătoare")
  const primaryTeachers = ['CA', 'SB', 'UL', 'NO', 'HM', 'ZG', 'CrM', 'RS', 'SE', 'TI', 'GA', 'MS', 'PV', 'TC', 'VC'];
  const periods = [];
  for (let p = 1; p <= 7; p++) periods.push({ period: p, start: `${7 + p}:00`, end: `${7 + p}:50` });

  /* ---------- timetable: no teacher is ever in two places at once ---------- */
  const busy = new Set(); // "day|period|code"
  const entries = [], classes = [];
  let sort = 0, pi = 0;
  for (const [level, grades, letters, perDay, pool_] of levels) {
    for (const grade of grades) {
      for (const letter of letters) {
        const cls = `${grade} ${letter}`;
        classes.push({ name: cls, level, grade, sort: sort++ });
        const own = level === 'primar' ? primaryTeachers[pi++ % primaryTeachers.length] : null;
        const homeRoom = rooms[crc32(cls) % 5];
        for (let day = 0; day < 5; day++) {
          const n = Math.max(3, Math.min(7, perDay + (rnd(0, 9) < 3 ? (level === 'liceu' ? -1 : 1) : 0)));
          let period = 1;
          while (period <= n) {
            const sub = pool_[rnd(0, pool_.length - 1)];
            const run = Math.min(n - period + 1, 1 + (rnd(0, 9) < 3 ? 1 : 0)); // sometimes a double lesson
            const candidates = ['Clr', 'Mem', 'Avp', 'Dp'].includes(sub) ? [own] : (bySubject[sub] ?? [own]);
            const teacher = candidates.find(t => { for (let k = 0; k < run; k++) if (busy.has(`${day}|${period + k}|${t}`)) return false; return true; });
            if (!teacher) { if (rnd(0, 4)) continue; period++; continue; } // try another subject, or leave a gap
            for (let k = 0; k < run; k++) {
              busy.add(`${day}|${period + k}|${teacher}`);
              entries.push({ class: cls, day, period: period + k, subject: sub, teachers: teacher, room: specialRoom[sub] ?? homeRoom, grp: '' });
            }
            period += run;
          }
        }
      }
    }
  }
  const monday = new Date(); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  await storeTimetable({
    periods, classes, days: 5, rooms, entries,
    teachers: teachers.map(([code, name]) => ({ code, name })),
    subjects: Object.entries(subjects).map(([code, name]) => ({ code, name })),
  }, ymd(addDays(monday, -14)), 'date demonstrative (populate)');
  console.log(`✓ orar: ${classes.length} clase, ${teachers.length} profesori, ${entries.length} ore`);

  /* ---------- substitutions: last week, this week, next week ---------- */
  await q('DELETE FROM substitutions');
  const names = Object.fromEntries(teachers);
  const codes = Object.keys(names);
  const slots = [[], [], [], [], []];
  for (const e of entries) slots[e.day].push(e);
  let count = 0;
  for (let w = -1; w <= 1; w++) {
    for (let day = 0; day < 5; day++) {
      const date = ymd(addDays(monday, w * 7 + day));
      const a = rnd(0, codes.length - 1); let b = rnd(0, codes.length - 2); if (b >= a) b++;
      const absentToday = [codes[a], codes[b]]; // two teachers are away for the whole day
      const usedToday = [];
      for (const e of slots[day]) {
        if (!absentToday.includes(e.teachers) || rnd(0, 9) < 2) continue;
        const free = codes.filter(c => !busy.has(`${day}|${e.period}|${c}`) && !absentToday.includes(c));
        if (!free.length) continue;
        const sub = free[rnd(0, free.length - 1)];
        busy.add(`${day}|${e.period}|${sub}`); usedToday.push(`${day}|${e.period}|${sub}`); // one substitution per teacher per period
        await q('INSERT INTO substitutions (sub_date, period, class_name, absent_code, absent_name, substitute_code, substitute_name, subject, room, note) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [date, e.period, e.class, e.teachers, names[e.teachers], sub, names[sub], e.subject, e.room, rnd(0, 6) ? '' : 'Elevii rămân în sală']);
        count++;
      }
      // free the substitutes again for the next week's copy of this day
      for (const k of usedToday) busy.delete(k);
    }
  }
  console.log(`✓ supliniri: ${count} (săptămâna trecută, curentă și următoare)`);

  /* ---------- demo accounts ---------- */
  const demo = [
    ['Elev Demo', 'elev@demo.local', 'elev', 'IX A', null, 'elev-demo-1'],
    ['Pop Daniel', 'profesor@demo.local', 'profesor', null, 'PD', 'profesor-demo-1'],
  ];
  if (!(await val("SELECT COUNT(*) FROM users WHERE role = 'admin'"))) demo.push(['Admin Demo', 'admin@demo.local', 'admin', null, null, 'admin-demo-1']);
  console.log('✓ conturi de test:');
  for (const [name, email, role, cls, code, pass] of demo) {
    if (await one('SELECT id FROM users WHERE email = ?', [email])) { console.log(`    ${email} există deja (neschimbat)`); continue; }
    await q('INSERT INTO users (name, email, password_hash, role, class_name, teacher_code) VALUES (?, ?, ?, ?, ?, ?)', [name, email, await hashPassword(pass), role, cls, code]);
    console.log(`    ${role}: ${email} / ${pass}`);
  }
  console.log('Gata.');
} catch (e) {
  console.error('\nEROARE: ' + e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
