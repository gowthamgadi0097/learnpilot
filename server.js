require('dotenv').config();
const path = require('path');
const express = require('express'), cors = require('cors'), Database = require('better-sqlite3');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { PORT = 3000, JWT_SECRET, TEACHER_EMAIL, TEACHER_PASSWORD, TEACHER_NAME = 'Teacher',
        MODEL = 'claude-sonnet-5-5', DB_FILE = 'learnpilot.db' } = process.env;
if (!JWT_SECRET) throw new Error('Set JWT_SECRET in your .env file');
const ai = process.env.ANTHROPIC_API_KEY ? new (require('@anthropic-ai/sdk'))() : null;   // loaded only when a key is set

/* ---------- database ---------- */
const db = new Database(DB_FILE);
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass TEXT NOT NULL, college TEXT, branch TEXT, year TEXT, roll TEXT UNIQUE, status TEXT DEFAULT 'pending', created INTEGER);
CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created INTEGER);
CREATE TABLE IF NOT EXISTS enrollments(student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE, PRIMARY KEY(student_id, course_id));
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, questions TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS results(id INTEGER PRIMARY KEY, student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE, score INTEGER, answer TEXT, feedback TEXT, created INTEGER,
  UNIQUE(student_id, item_id));
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, roll TEXT, name TEXT, college TEXT, email TEXT, created INTEGER);
`);
const PROD = process.env.NODE_ENV === 'production';
if (TEACHER_EMAIL && TEACHER_PASSWORD && !db.prepare("SELECT 1 FROM users WHERE role='teacher'").get()) {
  if (PROD && (TEACHER_PASSWORD === 'ChangeMe123' || TEACHER_PASSWORD.length < 8))
    throw new Error('Set a strong TEACHER_PASSWORD (8+ characters, not the default) before running in production');
  db.prepare("INSERT INTO users(role,name,email,pass,status,created) VALUES('teacher',?,?,?,'approved',?)")
    .run(TEACHER_NAME, TEACHER_EMAIL.toLowerCase(), bcrypt.hashSync(TEACHER_PASSWORD, 10), Date.now());
  console.log('Teacher account created:', TEACHER_EMAIL);
}
if (!db.prepare("SELECT 1 FROM users WHERE role='teacher'").get()) console.warn('WARNING: no teacher account. Set TEACHER_EMAIL and TEACHER_PASSWORD in .env and restart.');

/* ---------- helpers ---------- */
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(cors({ origin: process.env.CORS_ORIGIN || false }), express.json({ limit: '100kb' }));   // the app is same-origin; CORS stays off unless CORS_ORIGIN is set
app.use(express.static(path.join(__dirname, 'public')));   // the web app (public/index.html)
const wrap = f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
const sign = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '7d' });
const pub = ({ pass, ...u }) => u;
const get = (sql, ...p) => db.prepare(sql).get(...p), all = (sql, ...p) => db.prepare(sql).all(...p), run = (sql, ...p) => db.prepare(sql).run(...p);
const fail = (res, code, error) => res.status(code).json({ error });

const auth = roles => (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const u = get('SELECT * FROM users WHERE id=?', p.id);
    if (!u) throw new Error('no user');
    if (roles && !roles.includes(u.role)) return fail(res, 403, 'Forbidden');
    req.user = u; next();
  } catch { fail(res, 401, 'Please log in'); }
};
const anyUser = auth(), teacher = auth(['teacher']), student = auth(['student']);
const approved = (req, res, next) => req.user.status === 'approved' ? next()
  : res.status(403).json({ error: 'Waiting for teacher approval', status: req.user.status });

const hits = new Map();   // simple AI rate limit: 40 calls / 10 min per user
const limit = (req, res, next) => {
  const now = Date.now(), h = (hits.get(req.user.id) || []).filter(t => now - t < 600000);
  if (h.length >= 40) return fail(res, 429, 'Too many AI requests, try again later');
  h.push(now); hits.set(req.user.id, h); next();
};
async function llm(system, messages, max = 1500) {
  if (!ai) throw Object.assign(new Error('AI is not configured: set ANTHROPIC_API_KEY'), { status: 503 });
  const r = await ai.messages.create({ model: MODEL, max_tokens: max, system, messages });
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('');
}
const parseQs = t => {
  const qs = JSON.parse(t.replace(/```json|```/g, '').trim());
  if (!Array.isArray(qs) || !qs.every(x => x.q && Array.isArray(x.options) && x.options.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4))
    throw Object.assign(new Error('AI returned an invalid quiz, please retry'), { status: 502 });
  return qs.map(({ q, options, answer, explain }) => ({ q, options, answer, explain: explain || '' }));
};

/* ---------- auth ---------- */
const ROLL = /^24KX[A-Z0-9]{6}$/;
app.post('/api/auth/register', wrap((req, res) => {
  const b = req.body || {}, s = v => String(v || '').trim();
  const name = s(b.name), college = s(b.college), branch = s(b.branch), year = s(b.year);
  const email = s(b.email).toLowerCase(), roll = s(b.roll).toUpperCase();
  if (!name || !college || !branch || !year || !email || s(b.password).length < 6)
    return fail(res, 400, 'Name, college, branch, year, email and a password (6+ chars) are required');
  if (!ROLL.test(roll)) return fail(res, 400, 'Roll no. must be 10 characters starting with 24KX (e.g. 24KX1A3010)');
  if (get('SELECT 1 FROM users WHERE roll=?', roll)) {       // duplicate roll -> alert the teacher
    if (!get('SELECT 1 FROM alerts WHERE roll=? AND email=?', roll, email))   // one alert per roll+email, so it can't be flooded
      run('INSERT INTO alerts(roll,name,college,email,created) VALUES(?,?,?,?,?)', roll, name, college, email, Date.now());
    return fail(res, 409, 'This roll no. is already registered with another account. Your teacher has been notified.');
  }
  if (get('SELECT 1 FROM users WHERE email=?', email)) return fail(res, 409, 'Email already registered');
  const id = run("INSERT INTO users(role,name,email,pass,college,branch,year,roll,status,created) VALUES('student',?,?,?,?,?,?,?, 'pending',?)",
    name, email, bcrypt.hashSync(String(b.password), 10), college, branch, year, roll, Date.now()).lastInsertRowid;
  res.status(201).json({ token: sign({ id }), user: pub(get('SELECT * FROM users WHERE id=?', id)) });
}));
const fails = new Map();   // brute-force guard: 8 wrong passwords per 15 min for each IP + email
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';
app.post('/api/auth/login', wrap((req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(), key = clientIp(req) + '|' + email, now = Date.now();
  const f = (fails.get(key) || []).filter(t => now - t < 900000);
  if (f.length >= 8) return fail(res, 429, 'Too many wrong attempts. Please try again in 15 minutes.');
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (!u || !bcrypt.compareSync(String(req.body?.password || ''), u.pass)) {
    if (fails.size > 5000) fails.clear();
    fails.set(key, [...f, now]); return fail(res, 401, 'Wrong email or password');
  }
  fails.delete(key);
  res.json({ token: sign(u), user: pub(u) });
}));
app.get('/api/me', anyUser, (req, res) => res.json(pub(req.user)));
app.patch('/api/me', student, (req, res) => {          // roll no. is locked; only these can change
  const { name, college, branch, year } = req.body || {};
  run('UPDATE users SET name=COALESCE(?,name),college=COALESCE(?,college),branch=COALESCE(?,branch),year=COALESCE(?,year) WHERE id=?',
    name || null, college || null, branch || null, year || null, req.user.id);
  res.json(pub(get('SELECT * FROM users WHERE id=?', req.user.id)));
});
app.delete('/api/me', student, (req, res) => { run('DELETE FROM users WHERE id=?', req.user.id); res.json({ ok: true }); });

/* ---------- teacher: courses & content ---------- */
app.get('/api/courses', teacher, (req, res) => res.json(all('SELECT c.*,(SELECT COUNT(*) FROM items WHERE course_id=c.id) AS itemCount FROM courses c ORDER BY id')));
app.post('/api/courses', teacher, (req, res) => {
  const name = String(req.body?.name || '').trim(); if (!name) return fail(res, 400, 'Course name required');
  res.status(201).json(get('SELECT * FROM courses WHERE id=?', run('INSERT INTO courses(name,created) VALUES(?,?)', name, Date.now()).lastInsertRowid));
});
app.delete('/api/courses/:id', teacher, (req, res) => { run('DELETE FROM courses WHERE id=?', req.params.id); res.json({ ok: true }); });
app.get('/api/courses/:id/items', teacher, (req, res) =>
  res.json(all('SELECT * FROM items WHERE course_id=? ORDER BY id', req.params.id).map(i => ({ ...i, questions: i.questions && JSON.parse(i.questions) }))));

app.post('/api/ai/generate', teacher, limit, wrap(async (req, res) => {       // draft only, not saved
  const { kind, topic, level = 'B.Tech undergraduate', count = 5 } = req.body || {};
  if (!['quiz', 'exam', 'assignment'].includes(kind) || !topic) return fail(res, 400, 'kind (quiz|exam|assignment) and topic required');
  const about = `the B.Tech engineering topic "${topic}" for ${level} students`;
  if (kind === 'assignment') {
    const body = await llm('You are an engineering professor.', [{ role: 'user', content:
      `Write a university-level assignment on ${about}: short theory recap, 4-6 problems (numericals, derivations, design or programming as suited), marks per problem, submission guidelines and evaluation criteria. Plain text.` }], 2000);
    return res.json({ kind, title: 'Assignment: ' + topic, body });
  }
  const n = Math.min(Math.max(+count || 5, 3), 20);
  const questions = parseQs(await llm('You are an engineering professor. Reply with JSON only.', [{ role: 'user', content:
    `Create ${n} multiple-choice questions (${kind === 'exam' ? 'university semester-exam style' : 'quiz'}) on ${about}, mixing conceptual, numerical/code-output and application questions. Return ONLY a JSON array: [{"q":"","options":["","","",""],"answer":0,"explain":""}] where answer is the index of the correct option.` }], 4000));
  res.json({ kind, title: (kind === 'exam' ? 'Exam: ' : 'Quiz: ') + topic, questions });
}));
app.post('/api/courses/:id/items', teacher, (req, res) => {   // publish (teacher may edit the draft first)
  const { kind, title, body, questions } = req.body || {};
  if (!get('SELECT 1 FROM courses WHERE id=?', req.params.id)) return fail(res, 404, 'Course not found');
  if (!['quiz', 'exam', 'assignment'].includes(kind) || !title) return fail(res, 400, 'kind and title required');
  let q = null;
  if (kind === 'assignment') { if (!body) return fail(res, 400, 'Assignment body required'); }
  else try { q = JSON.stringify(parseQs(JSON.stringify(questions))); } catch { return fail(res, 400, 'Invalid questions'); }
  const id = run('INSERT INTO items(course_id,kind,title,body,questions,created) VALUES(?,?,?,?,?,?)', req.params.id, kind, title, body || null, q, Date.now()).lastInsertRowid;
  res.status(201).json({ id });
});
app.delete('/api/items/:id', teacher, (req, res) => { run('DELETE FROM items WHERE id=?', req.params.id); res.json({ ok: true }); });
app.delete('/api/courses/:id/items', teacher, (req, res) => { run('DELETE FROM items WHERE course_id=?', req.params.id); res.json({ ok: true }); });

/* ---------- teacher: students, approvals, alerts, results ---------- */
app.get('/api/students', teacher, (req, res) => res.json(all("SELECT * FROM users WHERE role='student' ORDER BY created DESC").map(u => ({
  ...pub(u), courseIds: all('SELECT course_id FROM enrollments WHERE student_id=?', u.id).map(r => r.course_id) }))));
app.post('/api/students/:id/approve', teacher, (req, res) => {
  const sid = Number(req.params.id), ids = (req.body?.courseIds || []).map(Number).filter(Boolean);
  if (!ids.length) return fail(res, 400, 'Select at least one course');
  if (!get("SELECT 1 FROM users WHERE id=? AND role='student'", sid)) return fail(res, 404, 'Student not found');
  db.transaction(() => {
    run("UPDATE users SET status='approved' WHERE id=?", sid);
    run('DELETE FROM enrollments WHERE student_id=?', sid);
    ids.forEach(c => run('INSERT OR IGNORE INTO enrollments(student_id,course_id) SELECT ?,id FROM courses WHERE id=?', sid, c));
  })();
  res.json({ ok: true });
});
app.post('/api/students/:id/decline', teacher, (req, res) => { run("UPDATE users SET status='declined' WHERE id=? AND role='student'", req.params.id); res.json({ ok: true }); });
app.post('/api/students/:id/remove', teacher, (req, res) => {   // back to waiting list
  run("UPDATE users SET status='pending' WHERE id=? AND role='student'", req.params.id);
  run('DELETE FROM enrollments WHERE student_id=?', req.params.id); res.json({ ok: true });
});
app.delete('/api/students/:id', teacher, (req, res) => { run("DELETE FROM users WHERE id=? AND role='student'", req.params.id); res.json({ ok: true }); });
app.delete('/api/students', teacher, (req, res) => {            // ?status=waiting | approved
  const s = req.query.status;
  if (s === 'waiting') run("DELETE FROM users WHERE role='student' AND status!='approved'");
  else if (s === 'approved') run("DELETE FROM users WHERE role='student' AND status='approved'");
  else return fail(res, 400, 'status must be waiting or approved');
  res.json({ ok: true });
});
app.get('/api/alerts', teacher, (req, res) => res.json(all('SELECT a.*,(SELECT name FROM users WHERE roll=a.roll) AS ownerName FROM alerts a ORDER BY created DESC')));
app.delete('/api/alerts/:id', teacher, (req, res) => { run('DELETE FROM alerts WHERE id=?', req.params.id); res.json({ ok: true }); });
app.delete('/api/alerts', teacher, (req, res) => { run('DELETE FROM alerts'); res.json({ ok: true }); });
app.get('/api/results', teacher, (req, res) => res.json(all(
  `SELECT r.id,r.student_id,r.item_id,r.score,r.feedback,r.created,u.name,u.roll,u.branch,u.year,u.college,i.title,i.kind,i.course_id
   FROM results r JOIN users u ON u.id=r.student_id JOIN items i ON i.id=r.item_id
   ${req.query.courseId ? 'WHERE i.course_id=?' : ''} ORDER BY r.created DESC`, ...(req.query.courseId ? [req.query.courseId] : []))));
app.delete('/api/all', teacher, (req, res) => {                  // "danger zone"
  if (req.body?.confirm !== 'DELETE') return fail(res, 400, 'Send {"confirm":"DELETE"}');
  db.transaction(() => ['results', 'items', 'enrollments', 'courses', 'alerts'].forEach(t => run(`DELETE FROM ${t}`)) || run("DELETE FROM users WHERE role='student'"))();
  res.json({ ok: true });
});

/* ---------- student portal ---------- */
app.get('/api/my/courses', student, approved, (req, res) => res.json(
  all('SELECT c.* FROM courses c JOIN enrollments e ON e.course_id=c.id WHERE e.student_id=? ORDER BY c.id', req.user.id).map(c => ({
    ...c, items: all('SELECT * FROM items WHERE course_id=? ORDER BY id', c.id).map(i => ({
      id: i.id, kind: i.kind, title: i.title, body: i.body,
      questions: i.questions && JSON.parse(i.questions).map(({ q, options }) => ({ q, options })),   // answers never sent
      result: get('SELECT score,answer,feedback FROM results WHERE student_id=? AND item_id=?', req.user.id, i.id) || null })) }))));
app.post('/api/items/:id/submit', student, approved, limit, wrap(async (req, res) => {
  const it = get('SELECT i.* FROM items i JOIN enrollments e ON e.course_id=i.course_id WHERE i.id=? AND e.student_id=?', req.params.id, req.user.id);
  if (!it) return fail(res, 404, 'Not found in your courses');
  if (get('SELECT 1 FROM results WHERE student_id=? AND item_id=?', req.user.id, it.id)) return fail(res, 409, 'Already submitted');
  if (it.kind === 'assignment') {
    const text = String(req.body?.text || '').trim(); if (!text) return fail(res, 400, 'Write your answer first');
    const feedback = await llm('You are a supportive B.Tech professor.', [{ role: 'user', content:
      `Assignment:\n${it.body}\n\nStudent answer:\n${text.slice(0, 8000)}\n\nGive brief constructive feedback on technical correctness, method and presentation, with strengths and improvements (no final grade).` }]);
    run('INSERT INTO results(student_id,item_id,answer,feedback,created) VALUES(?,?,?,?,?)', req.user.id, it.id, text, feedback, Date.now());
    return res.json({ feedback });
  }
  const qs = JSON.parse(it.questions), ans = req.body?.answers;
  if (!Array.isArray(ans) || ans.length !== qs.length) return fail(res, 400, `Send answers: an array of ${qs.length} option indexes`);
  const right = qs.filter((q, i) => ans[i] === q.answer).length, score = Math.round(100 * right / qs.length);
  run('INSERT INTO results(student_id,item_id,score,answer,created) VALUES(?,?,?,?,?)', req.user.id, it.id, score, JSON.stringify(ans), Date.now());
  res.json({ score, right, total: qs.length, review: qs.map((q, i) => ({ correct: q.answer, yours: ans[i], explain: q.explain })) });
}));
app.get('/api/my/progress', student, (req, res) => res.json(all(
  'SELECT i.title,i.kind,r.score,r.created FROM results r JOIN items i ON i.id=r.item_id WHERE r.student_id=? ORDER BY r.created', req.user.id)));

app.post('/api/ai/tutor', student, approved, limit, wrap(async (req, res) => {
  let msgs = (Array.isArray(req.body?.messages) ? req.body.messages : []).slice(-12)
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return fail(res, 400, 'Send messages: [{role:"user",content:"..."}]');
  const subj = String(req.body?.subject || '').slice(0, 100);
  res.json({ reply: await llm(`You are a patient tutor for a B.Tech ${req.user.year || ''} ${req.user.branch || ''} engineering student${subj ? ' studying ' + subj : ''}. Explain with clear intuition, key formulas, step-by-step working or short code where useful, and a real-world engineering example. Keep it under 250 words and end with one short check question.`, msgs) });
}));
app.post('/api/ai/plan', student, approved, limit, wrap(async (req, res) => {
  const { goal, days = 7, hours = 1 } = req.body || {}; if (!goal) return fail(res, 400, 'goal required');
  res.json({ plan: await llm('You are a B.Tech study coach.', [{ role: 'user', content:
    `Create a day-by-day study plan for a B.Tech ${req.user.year} ${req.user.branch} student. Goal: ${String(goal).slice(0, 200)}. Days: ${+days || 7}. Hours per day: ${+hours || 1}. Include daily topics, theory revision, numericals/coding practice, previous-year questions, a short review and a final mock test. Plain text, concise.` }]) });
}));

app.get('/api/health', (req, res) => res.json({ ok: true, ai: !!ai }));
app.use('/api', (req, res) => fail(res, 404, 'Not found'));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) return fail(res, err.status === 400 ? 400 : 502, err.status === 400 ? 'Invalid JSON body' : 'AI returned invalid output, please retry');
  console.error(err); fail(res, err.status || 500, err.status ? err.message : 'Server error');
});
app.listen(PORT, () => {
  console.log(`LearnPilot backend running on http://localhost:${PORT}`);
  if (!ai) console.warn('AI is OFF: add ANTHROPIC_API_KEY to .env to enable the tutor, study plans and quiz generation.');
});
