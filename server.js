// Claude 戰情城 — local data server.
// Reads Claude Code transcripts (~/.claude/projects) incrementally, samples
// processes, and serves one JSON snapshot for the animated city page.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// --demo: made-up projects, for trying it out or taking screenshots without showing your own
const DEMO = process.argv.includes('--demo') || process.env.WARROOM_DEMO === '1';
const PORT = Number(process.env.PORT) || (DEMO ? 5178 : 5177);
const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const PUBLIC = path.join(__dirname, 'public');
const LAYOUT_FILE = path.join(__dirname, 'city-layout.json');
const SHOW_DAYS = 7;               // projects quiet for longer than this leave the map
const TICK_MS = 2000;
const WARMUP_BYTES = 2 * 1024 * 1024; // read this much before today's start to recover plan/title
const BIG_LINE = 300 * 1024;          // larger lines are tool output: skim instead of JSON.parse
const CHUNK = 8 * 1024 * 1024;

// ---------- transcript ingestion ----------

let dayStart = startOfToday();
let files = new Map();     // file path -> { offset, carry, sid, sub, mtime }
let sessions = new Map();  // session id -> session state
let loading = true;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function session(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = {
      id: sid, cwd: null, title: null, lastTs: 0, lastKind: null, stop: null, tool: null, lastText: null,
      plan: [], planTs: 0, tasks: [], tasksTs: 0, recap: null, recapTs: 0,
      energy: 0, tokens: 0, out: 0, seen: new Set(), subTs: 0, recent: [],
    };
    sessions.set(sid, s);
  }
  return s;
}

// Cost-weighted tokens: cache reads are cheap, output is expensive.
function energyOf(u) {
  const inp = u.input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0, out = u.output_tokens || 0;
  return { e: inp + cw * 1.25 + cr * 0.1 + out * 5, t: inp + cw + cr + out, out };
}

function applyPlan(s, input, ts) {
  if (Array.isArray(input.items)) s.plan = input.items.map(i => ({ t: i.content, st: i.status }));
  if (input.advance) {
    const i = s.plan.findIndex(x => x.st === 'in_progress');
    if (i >= 0) s.plan[i].st = 'completed';
    const j = s.plan.findIndex(x => x.st === 'pending');
    if (j >= 0) s.plan[j].st = 'in_progress';
  }
  if (Array.isArray(input.done)) for (const n of input.done) if (s.plan[n - 1]) s.plan[n - 1].st = 'completed';
  if (input.start && s.plan[input.start - 1]) {
    for (const x of s.plan) if (x.st === 'in_progress') x.st = 'pending';
    s.plan[input.start - 1].st = 'in_progress';
  }
  s.planTs = ts;
}

function applyTool(s, name, input, ts) {
  input = input || {};
  if (name === 'mcp__ccd_turn__update_plan') applyPlan(s, input, ts);
  else if (name === 'mcp__ccd_turn__wrap_up') {
    for (const x of s.plan) x.st = 'completed';
    if (input.recap) { s.recap = input.recap; s.recapTs = ts; }
  } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    s.plan = input.todos.map(t => ({ t: t.status === 'in_progress' ? (t.activeForm || t.content) : t.content, st: t.status }));
    s.planTs = ts;
  } else if (name === 'TaskCreate') {
    if (s.tasks.length && s.tasks.every(x => x.st === 'completed')) s.tasks = [];
    s.tasks.push({ id: String(s.tasks.length + 1), t: input.subject, active: input.activeForm, st: 'pending' });
    s.tasksTs = ts;
  } else if (name === 'TaskUpdate') {
    const k = s.tasks.find(x => x.id === String(input.taskId));
    if (k) {
      if (input.status === 'deleted') s.tasks = s.tasks.filter(x => x !== k);
      else if (input.status) k.st = input.status;
      if (input.subject) k.t = input.subject;
      if (input.activeForm) k.active = input.activeForm;
    }
    s.tasksTs = ts;
  }
}

function handleRecord(o, f) {
  const s = session(f.sid);
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
  if (o.cwd && !s.cwd) s.cwd = o.cwd;
  if (o.type === 'custom-title') { s.title = o.customTitle; return; }
  if (o.type === 'agent-name') { s.title = s.title || o.agentName; return; }
  if (o.type === 'ai-title') { s.title = s.title || o.aiTitle; return; }

  if (o.type === 'assistant' && o.message) {
    const m = o.message;
    if (m.id && !s.seen.has(m.id) && m.usage) {
      s.seen.add(m.id);
      if (ts >= dayStart) {
        const { e, t, out } = energyOf(m.usage);
        s.energy += e; s.tokens += t; s.out += out;
        s.recent.push([ts, e]);
      }
    }
    if (f.sub) { s.subTs = Math.max(s.subTs, ts); return; }
    s.lastTs = Math.max(s.lastTs, ts);
    s.lastKind = 'assistant';
    s.stop = m.stop_reason || s.stop;
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text.trim()) s.lastText = b.text;
      if (b.type !== 'tool_use') continue;
      s.tool = b.name;
      applyTool(s, b.name, b.input, ts);
    }
    return;
  }

  if (o.type === 'user' && o.message && !f.sub && !o.isMeta) {
    const c = o.message.content;
    const isResult = Array.isArray(c) && c.some(b => b.type === 'tool_result');
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
    s.lastTs = Math.max(s.lastTs, ts);
    if (isResult) s.lastKind = 'tool_result';
    else if (/^\[Request interrupted/.test(text)) s.lastKind = 'interrupted';
    else { s.lastKind = 'prompt'; s.stop = null; }
  }
}

// Huge lines (images, long tool output) are skimmed: type, timestamp, cwd only.
function skimLine(buf, start, end, f) {
  const head = buf.toString('utf8', start, Math.min(end, start + 400));
  const tail = buf.toString('utf8', Math.max(start, end - 2000), end);
  const type = (head.match(/"type":"([\w-]+)"/) || [])[1];
  if (type === 'message') return false; // assistant record: needs a real parse
  if (type !== 'user' || f.sub) return true;
  const s = session(f.sid);
  const ts = Date.parse((tail.match(/"timestamp":"([^"]+)"/) || [])[1] || '') || 0;
  const cwd = (tail.match(/"cwd":"([^"]+)"/) || [])[1];
  if (cwd && !s.cwd) s.cwd = cwd;
  if (ts) { s.lastTs = Math.max(s.lastTs, ts); s.lastKind = 'tool_result'; }
  return true;
}

function processBuffer(buf, f) {
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    if (nl > pos) {
      if (nl - pos > BIG_LINE && skimLine(buf, pos, nl, f)) { /* skimmed */ }
      else {
        try { handleRecord(JSON.parse(buf.toString('utf8', pos, nl)), f); } catch { /* partial or odd line */ }
      }
    }
    pos = nl + 1;
  }
  return buf.subarray(pos);
}

function firstTsAfter(fd, pos, size) {
  const len = Math.min(1024 * 1024, size - pos);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  const s = buf.toString('utf8');
  const m = s.slice(s.indexOf('\n') + 1).match(/"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/);
  return m ? Date.parse(m[1]) : null;
}

// Binary search the byte offset where today's records begin.
function offsetForDayStart(fd, size) {
  let lo = 0, hi = size;
  while (hi - lo > 512 * 1024) {
    const mid = Math.floor((lo + hi) / 2);
    const t = firstTsAfter(fd, mid, size);
    if (t === null || t < dayStart) lo = mid; else hi = mid;
  }
  return lo;
}

function readRange(fd, f, from, to) {
  let carry = f.carry;
  for (let p = from; p < to; p += CHUNK) {
    const len = Math.min(CHUNK, to - p);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, p);
    carry = processBuffer(carry.length ? Buffer.concat([carry, buf]) : buf, f);
  }
  f.carry = Buffer.from(carry);
}

function ingestFile(file, st) {
  let f = files.get(file);
  if (f && st.size === f.offset) { f.mtime = st.mtimeMs; return; }
  const fd = fs.openSync(file, 'r');
  try {
    if (!f) {
      const sub = file.includes(`${path.sep}subagents${path.sep}`);
      const sid = sub ? path.basename(path.dirname(path.dirname(file))) : path.basename(file, '.jsonl');
      f = { offset: 0, carry: Buffer.alloc(0), sid, sub, mtime: st.mtimeMs };
      files.set(file, f);
      const today = st.mtimeMs >= dayStart ? offsetForDayStart(fd, st.size) : st.size;
      let from = Math.max(0, today - WARMUP_BYTES);
      if (from > 0) {
        // align to the next full line
        const probe = Buffer.alloc(Math.min(4 * 1024 * 1024, st.size - from));
        fs.readSync(fd, probe, 0, probe.length, from);
        const nl = probe.indexOf(10);
        from = nl < 0 ? st.size : from + nl + 1;
      }
      f.offset = from;
    }
    if (st.size < f.offset) { f.offset = 0; f.carry = Buffer.alloc(0); } // truncated/rewritten
    readRange(fd, f, f.offset, st.size);
    f.offset = st.size;
    f.mtime = st.mtimeMs;
    if (f.sub) session(f.sid).subTs = Math.max(session(f.sid).subTs, st.mtimeMs);
  } finally {
    fs.closeSync(fd);
  }
}

function listTranscripts() {
  const out = [];
  const minMtime = Date.now() - SHOW_DAYS * 86400000;
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(ROOT, d.name);
    let entries = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(pdir, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      else if (e.isDirectory()) {
        const sdir = path.join(p, 'subagents');
        try {
          for (const a of fs.readdirSync(sdir)) if (a.endsWith('.jsonl')) out.push(path.join(sdir, a));
        } catch { /* no subagents */ }
      }
    }
  }
  return out.map(p => {
    try { return [p, fs.statSync(p)]; } catch { return null; }
  }).filter(x => x && x[1].mtimeMs >= minMtime);
}

async function ingestAll() {
  if (startOfToday() !== dayStart) { // new day: recount from scratch
    dayStart = startOfToday();
    files = new Map();
    sessions = new Map();
  }
  const list = listTranscripts().sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
  for (const [p, st] of list) {
    try { ingestFile(p, st); } catch (e) { console.error('ingest', p, e.message); }
    if (loading) await new Promise(r => setImmediate(r)); // keep serving during first load
  }
  const cutoff = Date.now() - 10 * 60000;
  for (const s of sessions.values()) while (s.recent.length && s.recent[0][0] < cutoff) s.recent.shift();
}

// ---------- processes & machine ----------

function run(cmd, args) {
  return new Promise(res => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, out) => res(err ? '' : out)));
}

const pidCwd = new Map();
let lastCpu = os.cpus();
let machine = { cpu: 0, mem: 0, ncpu: os.cpus().length, load: os.loadavg()[0] };
let procs = { byCwd: new Map(), apps: [] };

function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    const dt = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
    total += dt; idle += t.idle - p.idle;
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

async function memPercent() {
  // os.freemem() on a Mac leaves out reclaimable cache, so it reads as nearly full; vm_stat is exact
  if (process.platform !== 'darwin') return Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const out = await run('vm_stat', []);
  const page = Number((out.match(/page size of (\d+)/) || [])[1]) || 16384;
  const get = k => Number((out.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1]) || 0;
  const used = (get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')) * page;
  return Math.min(100, Math.round(used / os.totalmem() * 100));
}

// lsof -F prints non-ASCII bytes as \xNN
function unescapeLsof(s) {
  if (!s.includes('\\x')) return s;
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === 'x') { bytes.push(parseInt(s.substr(i + 2, 2), 16)); i += 3; }
    else bytes.push(...Buffer.from(s[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}

function appName(comm) {
  const m = comm.match(/\/([^/]+)\.app\//);
  return m ? m[1] : path.basename(comm);
}

async function sampleProcesses() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm=']);
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (m) list.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4] * 1024, comm: m[5] });
  }
  const kids = new Map();
  for (const p of list) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const roots = list.filter(p => path.basename(p.comm) === 'claude');
  const unknown = roots.filter(p => !pidCwd.has(p.pid)).map(p => p.pid);
  if (unknown.length) {
    const lo = await run('lsof', ['-a', '-d', 'cwd', '-p', unknown.join(','), '-Fpn']);
    let cur = null;
    for (const l of lo.split('\n')) {
      if (l[0] === 'p') cur = +l.slice(1);
      else if (l[0] === 'n' && cur) pidCwd.set(cur, unescapeLsof(l.slice(1)));
    }
    for (const pid of unknown) if (!pidCwd.has(pid)) pidCwd.set(pid, null); // unreadable: don't retry
  }
  const alive = new Set(list.map(p => p.pid));
  for (const pid of pidCwd.keys()) if (!alive.has(pid)) pidCwd.delete(pid);

  const claimed = new Set();
  const byCwd = new Map();
  for (const r of roots) {
    if (claimed.has(r.pid)) continue;
    let cpu = 0, rss = 0;
    const stack = [r];
    while (stack.length) {
      const p = stack.pop();
      if (claimed.has(p.pid)) continue;
      claimed.add(p.pid);
      cpu += p.cpu; rss += p.rss;
      for (const k of kids.get(p.pid) || []) stack.push(k);
    }
    const cwd = pidCwd.get(r.pid);
    if (!cwd) continue;
    const agg = byCwd.get(cwd) || { cpu: 0, rss: 0, n: 0 };
    agg.cpu += cpu; agg.rss += rss; agg.n += 1;
    byCwd.set(cwd, agg);
  }

  // Everything else on the Mac, grouped by app: the industrial zone.
  const apps = new Map();
  for (const p of list) {
    if (claimed.has(p.pid) || p.pid === process.pid) continue;
    const name = appName(p.comm);
    const a = apps.get(name) || { name, cpu: 0, rss: 0 };
    a.cpu += p.cpu; a.rss += p.rss;
    apps.set(name, a);
  }
  procs = {
    byCwd,
    apps: [...apps.values()].filter(a => a.cpu >= 3).sort((a, b) => b.cpu - a.cpu).slice(0, 4)
      .map(a => ({ name: a.name, cpu: Math.round(a.cpu), rss: a.rss })),
  };
  machine = { cpu: cpuPercent(), mem: await memPercent(), ncpu: os.cpus().length, load: os.loadavg()[0] };
}

// ---------- snapshot ----------

function loadLayout() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')); } catch { return {}; }
}
const layout = loadLayout();

function actOf(s) {
  if (s.lastKind === 'prompt' || s.lastKind === 'tool_result') return 'think';
  const n = s.tool || '';
  if (/^(Bash|BashOutput|KillShell|Monitor)$|terminal/i.test(n)) return 'bash';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return 'edit';
  if (/^(Read|Grep|Glob|LS|ToolSearch)$/.test(n)) return 'read';
  if (/^(WebSearch|WebFetch)$|Browser|chrome/i.test(n)) return 'web';
  if (/^(Agent|Task|Workflow|SendMessage)$/.test(n)) return 'agent';
  if (/update_plan|TaskCreate|TaskUpdate|TodoWrite|wrap_up|mark_chapter/.test(n)) return 'think';
  return 'mcp';
}

function stateOf(s, alive, now) {
  const age = now - s.lastTs;
  const busy = s.lastKind === 'prompt' || s.lastKind === 'tool_result' ||
    (s.lastKind === 'assistant' && s.stop === 'tool_use');
  // a running tool can be silent for a long time (builds, renders); thinking is not
  if (alive && busy && age < (s.lastKind === 'assistant' ? 30 * 60000 : 5 * 60000)) return 'work';
  if (alive && age < 3 * 3600000) return 'wait';
  return 'idle';
}

function progressOf(s) {
  const useTasks = s.tasks.length && s.tasksTs >= s.planTs;
  const items = useTasks ? s.tasks : s.plan;
  if (!items.length) return null;
  const cur = items.find(x => x.st === 'in_progress');
  return {
    done: items.filter(x => x.st === 'completed').length,
    total: items.length,
    now: cur ? (cur.active || cur.t) : null,
    steps: items.map(x => x.st[0]), // c / i / p
  };
}

function labelOf(cwd, title) {
  if (/scratch-workspaces|\/private\/(tmp|var)/.test(cwd)) return title || 'scratch';
  if (cwd === os.homedir()) return '~';
  return path.basename(cwd);
}

const RANK = { work: 3, wait: 2, idle: 1 };
let sessionStates = new Map(); // session id -> { st, s, key, name }, rebuilt by each snapshot

function snapshot() {
  const now = Date.now();
  sessionStates = new Map();
  if (loading) return { now, loading, dayStart, machine, apps: procs.apps, projects: [] };
  const projects = new Map();
  for (const s of sessions.values()) {
    if (!s.cwd) continue;
    const p = projects.get(s.cwd) || { cwd: s.cwd, sessions: [], energy: 0, tokens: 0, out: 0, rate: 0, lastTs: 0, subTs: 0 };
    p.sessions.push(s);
    p.energy += s.energy; p.tokens += s.tokens; p.out += s.out;
    p.rate += s.recent.filter(r => r[0] > now - 5 * 60000).reduce((a, r) => a + r[1], 0);
    p.lastTs = Math.max(p.lastTs, s.lastTs, s.subTs);
    p.subTs = Math.max(p.subTs, s.subTs);
    projects.set(s.cwd, p);
  }
  for (const cwd of procs.byCwd.keys()) {
    if (!projects.has(cwd)) projects.set(cwd, { cwd, sessions: [], energy: 0, tokens: 0, out: 0, rate: 0, lastTs: 0, subTs: 0 });
  }

  const out = [];
  let changed = false;
  for (const p of projects.values()) {
    const pr = procs.byCwd.get(p.cwd);
    const alive = !!pr;
    if (!alive && now - p.lastTs > SHOW_DAYS * 86400000) continue;
    const ranked = p.sessions.map(s => ({ s, st: stateOf(s, alive, now) }))
      .sort((a, b) => RANK[b.st] - RANK[a.st] || b.s.lastTs - a.s.lastTs);
    const top = ranked[0];
    const state = top ? top.st : (alive ? 'wait' : 'idle');
    const name = labelOf(p.cwd, top && top.s.title);
    for (const r of ranked) sessionStates.set(r.s.id, { st: r.st, s: r.s, key: p.cwd, name });
    const subs = [...files.values()].filter(f => f.sub && now - f.mtime < 30000 &&
      p.sessions.some(s => s.id === f.sid)).length;
    if (!(p.cwd in layout)) { layout[p.cwd] = Object.keys(layout).length; changed = true; }
    out.push({
      key: p.cwd,
      name,
      slot: layout[p.cwd],
      state,
      act: state === 'work' ? actOf(top.s) : null,
      tool: state === 'work' ? top.s.tool : null,
      title: top ? top.s.title : null,
      progress: top ? progressOf(top.s) : null,
      recap: top ? top.s.recap : null,
      working: ranked.filter(r => r.st === 'work').length,
      sessions: p.sessions.length,
      energy: Math.round(p.energy), tokens: p.tokens, out: p.out, rate: Math.round(p.rate),
      cpu: pr ? Math.round(pr.cpu) : 0, rss: pr ? pr.rss : 0, procs: pr ? pr.n : 0,
      lastTs: p.lastTs, idleMs: p.lastTs ? now - p.lastTs : null,
      subagents: subs,
    });
  }
  if (changed) {
    fs.writeFileSync(LAYOUT_FILE + '.tmp', JSON.stringify(layout, null, 1));
    fs.renameSync(LAYOUT_FILE + '.tmp', LAYOUT_FILE);
  }
  return { now, loading, dayStart, machine, apps: procs.apps, projects: out };
}

// Assign first-run slots by recency so the busiest projects land near the centre.
function seedLayout() {
  if (Object.keys(layout).length) return;
  const last = new Map();
  for (const s of sessions.values()) if (s.cwd) last.set(s.cwd, Math.max(last.get(s.cwd) || 0, s.lastTs));
  for (const cwd of procs.byCwd.keys()) last.set(cwd, Date.now());
  const min = Date.now() - SHOW_DAYS * 86400000;
  [...last].filter(([, t]) => t >= min).sort((a, b) => b[1] - a[1])
    .forEach(([cwd], i) => { layout[cwd] = i; });
}

// ---------- alerts: a session went from working to waiting for you ----------

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const settings = { alerts: true, phone: false }; // phone: off until you press 用手機看 in the menu bar app
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch { /* defaults */ }
const saveSettings = () => { if (!DEMO) fs.writeFile(SETTINGS_FILE, JSON.stringify(settings), () => {}); };

let prevStates = new Map();
const events = [];   // recent alerts, newest last; the page plays them
let lastPoll = 0;    // when a page someone is looking at last fetched /api/state
let lastMenubar = 0; // when the menu bar app last fetched it; while it runs, it shows the alerts
const menubarOn = () => Date.now() - lastMenubar < 10000;

function plain(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>|_~]+/g, '').replace(/\s+/g, ' ').trim();
}

function detectAlerts() {
  const now = Date.now();
  for (const [id, cur] of sessionStates) {
    if (prevStates.get(id) !== 'work' || cur.st !== 'wait') continue;
    const s = cur.s;
    if (s.lastKind === 'interrupted') continue; // you pressed stop yourself
    const recapFresh = s.recap && s.recapTs >= s.lastTs - 120000;
    const text = plain((recapFresh ? s.recap : s.lastText) || s.title || '完成了，輪到你');
    pushEvent({ ts: now, key: cur.key, name: cur.name, title: s.title, text: text.slice(0, 200), open: openLink(id) });
    // the menu bar app shows its own big alert; without it, fall back to a macOS notification
    // (with sound unless a dashboard page is open and chimes itself)
    if (settings.alerts && !menubarOn()) notifyMac(`${cur.name} 等你回覆`, text, now - lastPoll > 6000);
  }
  prevStates = new Map([...sessionStates].map(([id, v]) => [id, v.st]));
}

// The Claude app keeps one JSON per Code tab session; its first bytes name the app's id and the transcript's.
const APP_SESSIONS = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

function appSessionId(sid) {
  const head = Buffer.alloc(1024);
  const walk = dir => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of list) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { const hit = walk(f); if (hit) return hit; continue; }
      if (!/^local_.*\.json$/.test(e.name)) continue;
      let n = 0;
      try { const fd = fs.openSync(f, 'r'); n = fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd); } catch { continue; }
      const text = head.toString('utf8', 0, n);
      if (text.includes(`"cliSessionId":"${sid}"`)) return (text.match(/"sessionId":"(local_[\w-]+)"/) || [])[1] || null;
    }
    return null;
  };
  return walk(APP_SESSIONS);
}

// a link that opens this session's conversation in the Claude app (null: not a Code tab session, e.g. a terminal one)
function openLink(sid) {
  const id = process.platform === 'darwin' && appSessionId(sid);
  return id ? `claude://code/continue?session=${id}` : null;
}

function pushEvent(e) {
  events.push(e);
  if (events.length > 20) events.shift();
}

function notifyMac(subtitle, text, withSound) {
  if (process.platform !== 'darwin') return;
  // texts go in as argv so nothing from a transcript is ever parsed as AppleScript
  const script = [
    'on run argv',
    `display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)${withSound ? ' sound name "Glass"' : ''}`,
    'end run',
  ];
  execFile('osascript', [...script.flatMap(l => ['-e', l]), 'Claude 戰情城', subtitle, text.slice(0, 180)], () => {});
}

// ---------- phone access: off by default; once on, same Wi-Fi or Tailscale plus the secret key in .env ----------

const ENV_FILE = path.join(__dirname, '.env');

function phoneKey() {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* first run */ }
  const m = text.match(/^WARROOM_KEY=(\S+)/m);
  if (m) return m[1];
  const key = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(ENV_FILE, `${text}${text && !text.endsWith('\n') ? '\n' : ''}WARROOM_KEY=${key}\n`, { mode: 0o600 });
  return key;
}
const KEY = phoneKey();

const isLocal = addr => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
const keyOk = k => typeof k === 'string' && k.length === KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(KEY));
const cookieKey = req => ((req.headers.cookie || '').match(/(?:^|;\s*)wr=([^;]+)/) || [])[1];
// IP addresses, localhost and *.local only: a web page that points its own domain at us gets nothing
const hostOk = h => /^(localhost|[\d.]+|\[[\da-f:]+\]|[\w-]+\.local)(:\d+)?$/i.test(h || '');

// lan: same Wi-Fi; ts: Tailscale (100.64.0.0/10), reachable from anywhere your own devices are signed in
function addresses() {
  const all = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => list.map(a => ({ name, ...a })))
    .filter(a => (a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.'));
  const isTs = a => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address);
  const lan = all.filter(a => !isTs(a));
  return {
    lan: (lan.find(a => a.name === 'en0') || lan[0] || {}).address || null,
    ts: (all.find(isTs) || {}).address || null,
  };
}

const LOCKED = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude 戰情城</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#05080f;color:#e2e9ff;
font:16px/1.7 -apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;text-align:center;padding:24px;box-sizing:border-box">
<div><div style="font-size:42px">🔒</div>請在 Mac 上方選單列的城市圖示<br>按「用手機看」，再用手機相機掃 QR code</div>`;

// ---------- demo: a made-up city (--demo) ----------

// [folder, session title, what the AI says when it's done, plan, energy today in millions]
const DEMO_PROJECTS = [
  ['my-blog', '部落格改版', '首頁換成卡片排版了，手機版也看過，沒有跑版。', ['看現在的版面', '改首頁排版', '調手機版', '跑一次建置'], 9],
  ['旅行相簿', '照片自動分類', '照片依拍攝地點分好了，共 312 張，放在 sorted 資料夾。', ['讀照片資訊', '依地點分組', '產生縮圖', '寫分類報告'], 6.5],
  ['記帳-app', '月報表圖表', '月報表加上圓餅圖了，打開看看顏色喜不喜歡。', ['整理資料格式', '畫圓餅圖', '加上月份切換', '測試', '更新說明'], 4.8],
  ['game-jam', '跳躍手感調整', '跳躍改成按越久跳越高，落地加了一點揚塵。', ['找出跳躍程式', '改跳躍曲線', '加落地特效'], 3.4],
  ['podcast-剪輯', '逐字稿轉字幕', '字幕檔做好了，第 12 分鐘那段口誤我標起來給你確認。', ['讀逐字稿', '切成字幕段落', '對時間軸', '輸出 SRT'], 2.2],
  ['食譜網站', '加上搜尋', '搜尋做好了，可以用食材找食譜，打「蛋」試試看。', ['看資料結構', '做搜尋框', '加食材篩選', '測試搜尋'], 1.4],
  ['作品集', null, null, [], 0.6],
  ['期末報告', null, null, [], 0],
  ['dotfiles', null, null, [], 0],
];
const DEMO_ACTS = [['think', null], ['read', 'Grep'], ['edit', 'Edit'], ['bash', 'Bash'], ['web', 'WebFetch'], ['edit', 'Write'], ['agent', 'Agent'], ['mcp', 'mcp__figma__get_file']];
const DEMO_IDLE = [2, 26, 74]; // hours the quiet projects have been idle
const DEMO_PERIOD = 240, DEMO_WORK = 170; // seconds: each active project works, then waits for you
const demoStart = Date.now();
const demoPrev = new Map();

function demoSnapshot() {
  const now = Date.now(), t = (now - demoStart) / 1000;
  const wave = (p, a, b) => a + (b - a) * (0.5 + 0.5 * Math.sin(t / p));
  const active = DEMO_PROJECTS.filter(p => p[1]).length;
  const projects = DEMO_PROJECTS.map(([name, title, done, plan, mil], i) => {
    const key = `/Users/demo/projects/${name}`;
    const base = { key, name, slot: i, title, recap: null, progress: null, act: null, tool: null, working: 0, sessions: 1, subagents: 0, cpu: 0, rss: 0, procs: 0 };
    if (!title) {
      const idleMs = DEMO_IDLE[i - active] * 3600000, energy = mil * 1e6;
      return { ...base, state: 'idle', energy, tokens: energy * 3, out: energy * 0.02, rate: 0, lastTs: now - idleMs, idleMs };
    }
    const phase = (t + 40 * i) % DEMO_PERIOD, lap = Math.floor((t + 40 * i) / DEMO_PERIOD);
    const work = phase < DEMO_WORK;
    const energy = Math.round(mil * 1e6 * (1 + 0.04 * (lap + Math.min(phase, DEMO_WORK) / DEMO_WORK)));
    const k = work ? Math.floor(phase / DEMO_WORK * plan.length) : plan.length; // plan steps done
    const p = {
      ...base, energy, tokens: energy * 3, out: Math.round(energy * 0.02), procs: 1,
      progress: { done: k, total: plan.length, now: plan[k] || null, steps: plan.map((_, j) => (j < k ? 'c' : j === k ? 'i' : 'p')) },
    };
    if (work) {
      const [act, tool] = DEMO_ACTS[(Math.floor(phase / 14) + i) % DEMO_ACTS.length];
      Object.assign(p, {
        state: 'work', act, tool, working: 1, subagents: act === 'agent' ? 2 : 0,
        cpu: Math.round(wave(3 + i, 3, 25 + i * 6)), rss: 320e6, rate: Math.round(mil * 4e4 * wave(5 + i, 0.5, 1.5)),
        lastTs: now - (phase % 14) * 1000, idleMs: (phase % 14) * 1000,
      });
    } else {
      const since = (phase - DEMO_WORK) * 1000;
      Object.assign(p, { state: 'wait', recap: done, rss: 240e6, rate: 0, lastTs: now - since, idleMs: since });
      if (demoPrev.get(name) === 'work') pushEvent({ ts: now, key, name, title, text: done, open: null });
    }
    demoPrev.set(name, p.state);
    return p;
  });
  const machine = { cpu: Math.round(wave(7, 18, 46)), mem: Math.round(wave(11, 58, 66)), ncpu: os.cpus().length, load: wave(9, 2, 5) };
  const apps = [{ name: '影片轉檔', cpu: Math.round(wave(8, 40, 95)), rss: 1.2e9 }, { name: 'Chrome', cpu: Math.round(wave(5, 6, 20)), rss: 2.1e9 }];
  return { now, loading: false, dayStart: startOfToday(), machine, apps, projects };
}

// ---------- http ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
let latest = DEMO ? demoSnapshot() : snapshot();

function readJson(req, done) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { let o = {}; try { o = JSON.parse(body) || {}; } catch { /* keep {} */ } done(o); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req.headers.host)) { res.writeHead(403); res.end(); return; }
  // this Mac itself: loopback *and* asked for by a loopback name (a tunnel or proxy on this Mac doesn't count)
  const local = isLocal(req.socket.remoteAddress) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host);
  if (!local) { // a phone: the QR code link carries the key once, then a cookie does
    if (keyOk(url.searchParams.get('k'))) res.setHeader('set-cookie', `wr=${KEY}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    else if (!keyOk(cookieKey(req))) { res.writeHead(401, { 'content-type': TYPES['.html'] }); res.end(LOCKED); return; }
  }
  if (url.pathname === '/api/phone' && local) { // the menu bar app: switch phone access on/off, get the QR code link
    const reply = () => {
      const { lan, ts } = phoneOn() ? addresses() : {};
      const link = ip => ip && `http://${ip}:${PORT}/?k=${KEY}`;
      res.writeHead(200, JSON_TYPE);
      res.end(JSON.stringify({ on: phoneOn(), ip: lan || null, url: link(lan) || null, ts: ts || null, tsUrl: link(ts) || null }));
    };
    // JSON-only, like /api/alerts, so another web page can't switch it on
    if (req.method === 'POST' && req.headers['content-type'] === 'application/json') {
      readJson(req, o => { settings.phone = !!o.on; saveSettings(); bind(reply); });
    } else reply();
    return;
  }
  if (url.pathname === '/api/state') {
    if (url.searchParams.get('visible') !== '0') lastPoll = Date.now();
    if (url.searchParams.get('client') === 'menubar') lastMenubar = Date.now();
    res.writeHead(200, JSON_TYPE);
    res.end(JSON.stringify({ ...latest, alerts: settings.alerts, events, menubar: menubarOn(), phone: phoneOn(), demo: DEMO }));
    return;
  }
  // JSON-only so a random web page can't flip it with a plain form post
  if (url.pathname === '/api/alerts' && req.method === 'POST' && req.headers['content-type'] === 'application/json') {
    readJson(req, o => {
      const was = settings.alerts;
      if ('on' in o) settings.alerts = !!o.on;
      saveSettings();
      if (settings.alerts && !was) { // switching on: send a sample so you can see it works
        const text = '有大樓做完、等你回覆時，會像這樣通知你';
        pushEvent({ ts: Date.now(), key: null, name: '提醒已開啟', title: null, text });
        if (!menubarOn()) notifyMac('提醒已開啟', text, false);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ alerts: settings.alerts }));
    });
    return;
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

// 127.0.0.1: this computer only. 0.0.0.0: phones too (each one still needs the key).
function bind(done = () => {}) {
  const host = process.env.WARROOM_HOST || (settings.phone && !DEMO ? '0.0.0.0' : '127.0.0.1');
  if (server.listening && server.address().address === host) { done(); return; }
  if (server.listening) server.close(); // open connections carry on; new ones reach the new address
  server.once('listening', done);
  server.listen(PORT, host);
}
const phoneOn = () => server.listening && server.address().address !== '127.0.0.1';
bind(() => {
  const page = `http://localhost:${PORT}/`;
  console.log(`Claude 戰情城${DEMO ? '（示範資料）' : ''} → ${page}`);
  if (!process.argv.includes('--open')) return; // the double-click launchers ask for the browser too
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', page], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [page], () => {});
});

async function loop() {
  const t0 = Date.now();
  try {
    if (DEMO) latest = demoSnapshot();
    else {
      await sampleProcesses();
      await ingestAll();
      if (loading) { seedLayout(); loading = false; console.log(`loaded ${files.size} transcripts in ${Date.now() - t0}ms`); }
      latest = snapshot();
      detectAlerts();
    }
  } catch (e) {
    console.error(e);
  }
  setTimeout(loop, Math.max(200, TICK_MS - (Date.now() - t0)));
}
loop();
