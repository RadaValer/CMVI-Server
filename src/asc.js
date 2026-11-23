import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { mbSub } from './validate.js';

/* Reads the XML exported by aSc Timetables (Fișier > Export > "aSc Timetables XML").
   Layout of that file:
     <timetable>
       <periods>   <period period="1" starttime="8:00" endtime="8:50"/>
       <subjects>  <subject id=".." name="Matematică" short="Mat"/>
       <teachers>  <teacher id=".." name="Pop Daniel" short="PD" firstname=".." lastname=".."/>
       <classrooms><classroom id=".." name="Sala 4" short="S4"/>
       <classes>   <class id=".." name="IX A" short="9A"/>
       <groups>    <group id=".." classid=".." name="Grupa 1" entireclass="0"/>
       <lessons>   <lesson id=".." classids="a,b" subjectid=".." teacherids="x,y" groupids=".."
                           classroomids=".." periodspercard="1"/>
       <cards>     <card lessonid=".." period="1" days="10000" classroomids=".."/>
     </timetable>
   "days" is one character per school day ("01000" = Tuesday); some exports use day="1" instead.

   Returns { periods, classes, teachers, subjects, rooms, entries, days, warnings };
   throws an AscError (message meant for the admin) when the file can't be used. */
export class AscError extends Error {}

const LISTS = new Set(['period', 'subject', 'teacher', 'classroom', 'class', 'group', 'lesson', 'card']);

/** Bytes -> text, honouring the encoding in the XML declaration (aSc may export windows-1250). */
export function decodeXml(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return new TextDecoder(buf[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(buf);
  const head = buf.subarray(0, 200).toString('latin1');
  const enc = (/<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(head) || [])[1];
  if (enc && !/^utf-?8$/i.test(enc)) { try { return new TextDecoder(enc).decode(buf); } catch { /* unknown label: try utf8 */ } }
  return buf.toString('utf8');
}

export function ascParse(xml) {
  if (!xml.trim()) throw new AscError('Fișierul este gol.');
  const ok = XMLValidator.validate(xml);
  if (ok !== true) throw new AscError(`Fișierul nu este un XML valid: ${ok.err.msg} (linia ${ok.err.line})`);
  const parsed = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false,
    ignoreDeclaration: true, ignorePiTags: true, processEntities: true, isArray: name => LISTS.has(name),
  }).parse(xml);
  const rootName = Object.keys(parsed).find(k => !k.startsWith('?') && k !== '#text');
  if (rootName !== 'timetable') throw new AscError(`Fișierul nu pare a fi un export aSc: elementul principal este <${rootName || '?'}>, se aștepta <timetable>.`);
  const doc = parsed.timetable || {};

  const list = (section, item) => { const s = doc[section]; return s && typeof s === 'object' && Array.isArray(s[item]) ? s[item] : []; };
  const a = (el, k) => (el && el[k] !== undefined && el[k] !== null ? String(el[k]).trim() : '');
  const ids = s => s.split(',').map(x => x.trim()).filter(Boolean);
  const numeric = s => s !== '' && isFinite(Number(s));
  const warnings = [];

  // periods
  const periods = new Map();
  for (const p of list('periods', 'period')) {
    const n = a(p, 'period') !== '' ? a(p, 'period') : a(p, 'name');
    if (!numeric(n)) continue;
    periods.set(parseInt(n, 10), { period: parseInt(n, 10), start: ascTime(a(p, 'starttime')), end: ascTime(a(p, 'endtime')) });
  }

  const subjects = new Map(), teachers = new Map(), rooms = new Map(), classes = new Map(), groups = new Map();
  for (const s of list('subjects', 'subject')) {
    const name = a(s, 'name'), short = a(s, 'short') || name;
    subjects.set(a(s, 'id'), { code: mbSub(short, 40), name: mbSub(name || short, 160) });
  }
  for (const t of list('teachers', 'teacher')) {
    const name = a(t, 'name') || `${a(t, 'lastname')} ${a(t, 'firstname')}`.trim();
    const short = a(t, 'short') || name;
    teachers.set(a(t, 'id'), { code: mbSub(short, 30), name: mbSub(name || short, 120) });
  }
  for (const r of list('classrooms', 'classroom')) rooms.set(a(r, 'id'), mbSub(a(r, 'name') || a(r, 'short'), 80));
  for (const c of list('classes', 'class')) {
    const name = a(c, 'name') || a(c, 'short');
    if (name === '') continue;
    classes.set(a(c, 'id'), { name: mbSub(name, 60), ...classLevel(name, a(c, 'short'), a(c, 'grade')) });
  }
  for (const g of list('groups', 'group')) groups.set(a(g, 'id'), { cls: a(g, 'classid'), name: a(g, 'name'), whole: a(g, 'entireclass') === '1' });
  if (!classes.size) throw new AscError('Fișierul nu conține nicio clasă (<classes>). Verifică dacă ai exportat formatul „aSc Timetables XML”.');

  const lessons = new Map();
  for (const l of list('lessons', 'lesson')) {
    lessons.set(a(l, 'id'), {
      classes: ids(a(l, 'classids')), subject: a(l, 'subjectid'), teachers: ids(a(l, 'teacherids')),
      groups: ids(a(l, 'groupids')), rooms: ids(a(l, 'classroomids')), span: Math.max(1, parseInt(a(l, 'periodspercard'), 10) || 1),
    });
  }

  // cards -> one placement per (lesson, day, period)
  let dayCount = 5, unknownLessons = 0;
  const byLessonDay = new Map();
  for (const c of list('cards', 'card')) {
    const lid = a(c, 'lessonid');
    if (!lessons.has(lid)) { unknownLessons++; continue; }
    const period = a(c, 'period');
    if (!numeric(period)) continue;
    const days = [];
    const mask = a(c, 'days');
    if (mask !== '' && /^[01]+$/.test(mask)) {
      dayCount = Math.max(dayCount, mask.length);
      for (let i = 0; i < mask.length; i++) if (mask[i] === '1') days.push(i);
    } else if (numeric(a(c, 'day'))) days.push(parseInt(a(c, 'day'), 10));
    for (const d of days) {
      const k = `${lid}|${d}`;
      if (!byLessonDay.has(k)) byLessonDay.set(k, []);
      byLessonDay.get(k).push({ lesson: lid, day: d, period: parseInt(period, 10), rooms: ids(a(c, 'classroomids')) });
    }
  }
  // a lesson lasting N periods is exported either as one card per period, or as a single card
  // at the first period; only the second form needs expanding.
  const placed = [];
  for (const cards of byLessonDay.values()) {
    const span = lessons.get(cards[0].lesson).span;
    for (const card of cards) {
      const n = cards.length === 1 ? span : 1;
      for (let k = 0; k < n; k++) placed.push({ ...card, period: card.period + k });
    }
  }
  if (unknownLessons) warnings.push(`${unknownLessons} ore din <cards> trimit la lecții inexistente și au fost ignorate.`);

  const entries = [], seen = new Set();
  for (const p of placed) {
    const lesson = lessons.get(p.lesson);
    const subject = subjects.get(lesson.subject)?.code ?? '?';
    const tcodes = lesson.teachers.map(id => teachers.get(id)?.code ?? '?').join(',');
    const roomIds = p.rooms.length ? p.rooms : lesson.rooms;
    const room = roomIds.map(id => rooms.get(id) || '').filter(Boolean).join(', ');
    for (const cid of lesson.classes) {
      if (!classes.has(cid)) continue;
      let grp = '';
      for (const gid of lesson.groups) {
        const g = groups.get(gid);
        if (g && g.cls === cid && !g.whole) grp = g.name;
      }
      const key = [cid, p.day, p.period, subject, tcodes, grp].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ class: classes.get(cid).name, day: p.day, period: p.period, subject: mbSub(subject, 40), teachers: mbSub(tcodes, 160), room: mbSub(room, 80), grp: mbSub(grp, 80) });
      if (!periods.has(p.period)) periods.set(p.period, { period: p.period, start: '', end: '' });
    }
  }
  if (!entries.length) throw new AscError('Fișierul nu conține nicio oră programată (<cards>). Exportă orarul după ce l-ai generat în aSc.');

  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const classList = [...classes.values()].sort((x, y) => x.rank - y.rank || cmp(x.name, y.name))
    .map(({ rank, ...c }, i) => ({ ...c, sort: i }));
  const dedupe = (rows, key) => { const m = new Map(); for (const r of rows) if (!m.has(r[key])) m.set(r[key], r); return [...m.values()]; };
  return {
    periods: [...periods.values()].sort((x, y) => x.period - y.period),
    classes: classList,
    teachers: dedupe([...teachers.values()], 'code'),
    subjects: dedupe([...subjects.values()], 'code'),
    rooms: [...new Set([...rooms.values()].filter(Boolean))],
    entries,
    days: Math.min(7, dayCount),
    warnings,
  };
}

export function ascTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? `${parseInt(m[1], 10)}:${m[2]}` : '';
}

const ROMAN = { XII: 12, XI: 11, X: 10, IX: 9, VIII: 8, VII: 7, VI: 6, V: 5, IV: 4, III: 3, II: 2, I: 1 };
const ROMAN_OF = Object.fromEntries(Object.entries(ROMAN).map(([k, v]) => [v, k]));

/** Works out the school level from the class name: "IX A", "9A", "a IX-a B", "Pregătitoare A"... */
export function classLevel(name, short = '', gradeAttr = '') {
  let grade = null;
  for (const s of [name, short]) {
    if (grade !== null || s === '') continue;
    if (/preg|^\s*0\b|^\s*P\b/iu.test(s)) { grade = 0; break; }
    let m = /\b(XII|XI|IX|X|VIII|VII|VI|IV|V|III|II|I)(?=\b|-|[A-Z\s])/u.exec(s.toUpperCase());
    if (m) { grade = ROMAN[m[1]]; break; }
    m = /(?<!\d)(1[0-2]|[0-9])(?!\d)/.exec(s);
    if (m) { grade = parseInt(m[1], 10); break; }
  }
  if (grade === null && gradeAttr !== '' && isFinite(Number(gradeAttr))) grade = parseInt(gradeAttr, 10);
  const level = grade === null ? 'altele' : grade <= 4 ? 'primar' : grade <= 8 ? 'gimnaziu' : 'liceu';
  const label = grade === null ? '' : grade === 0 ? '0' : ROMAN_OF[grade] || '';
  return { level, grade: label, rank: grade ?? 99 };
}
