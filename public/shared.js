'use strict';
// Claude 戰情城 — shared state, data polling, HTML panels, labels and alerts.
// The active renderer (city2d.js or city3d.js) draws the city and fills in `renderer`.

const POLL_MS = 2000;
const COL = { work: '#ffb547', wait: '#3fe0ff', idle: '#5b6886', off: '#3a4259', energy: '#ffe066', hot: '#ff5e5e' };
const ACT = {
  bash: ['⚙️', '跑指令'], edit: ['🏗️', '改檔案'], read: ['🔦', '讀取搜尋'], web: ['📡', '上網'],
  agent: ['🛸', '派分身'], think: ['💭', '思考中'], mcp: ['🔌', '外掛工具'],
};

const $ = id => document.getElementById(id);

let data = null;
const blds = new Map();
let nextId = 1;
let ringR = 2;
let factories = [];
let hoverKey = null;

// Filled in by the active renderer.
const renderer = {
  burst() {},   // (b, energyDelta): tokens were just spent in b
  layout() {},  // ringR changed
  focus() {},   // (key): bring a building into view
};

// ---------- helpers ----------

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

function hash(...n) {
  let h = 2166136261;
  for (const x of n) { h ^= (x * 374761393) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); }
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

function dur(ms) {
  if (ms == null) return '—';
  const m = ms / 60000;
  if (m < 1) return '剛剛';
  if (m < 60) return Math.floor(m) + 'm';
  if (m < 1440) return Math.floor(m / 60) + 'h';
  return Math.floor(m / 1440) + 'd';
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = v => clamp(Math.round(v * f), 0, 255);
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Grid cells in rings around the power plant at (0,0).
const cellCache = [];
function cellFor(i) {
  for (let r = 1; cellCache.length <= i; r++) {
    const ring = [];
    for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) if (Math.max(Math.abs(x), Math.abs(y)) === r) ring.push([x, y]);
    ring.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    cellCache.push(...ring);
  }
  return cellCache[i];
}
const ringOf = i => Math.max(Math.abs(cellFor(i)[0]), Math.abs(cellFor(i)[1]));

const panelW = () => (innerWidth > 900 ? 318 : 0);
// phones: the list is a sheet along the bottom (plus the energy strip above it)
const phone = () => innerWidth <= 600;
const sheetH = () => (phone() ? $('now').offsetHeight + 40 : 0);
const touchUI = matchMedia('(hover: none)').matches; // no hover: tap shows the info card

// ---------- data ----------

function ingest(d) {
  const sameDay = data && data.dayStart === d.dayStart;
  data = d;
  $('loading').hidden = !d.loading;
  $('demo').hidden = !d.demo;
  const visible = [...d.projects].sort((a, b) => a.slot - b.slot);
  const seen = new Set();
  visible.forEach((p, i) => {
    seen.add(p.key);
    let b = blds.get(p.key);
    if (!b) {
      b = { key: p.key, id: nextId++, e: p.energy };
      blds.set(p.key, b);
    }
    const spent = sameDay ? p.energy - b.e : 0;
    b.e = p.energy;
    b.p = p;
    b.kind = p.state === 'idle' && !p.procs ? 'off' : p.state;
    b.cell = cellFor(i);
    if (spent > 0) renderer.burst(b, spent);
  });
  for (const k of [...blds.keys()]) if (!seen.has(k)) blds.delete(k);

  const R = Math.max(2, visible.length ? ringOf(visible.length - 1) : 1);
  if (R !== ringR) { ringR = R; renderer.layout(); }
  const F = ringR + 1; // industrial zone: back-right edge, outside the project rings
  const fcells = [[1, -F], [0, -F], [2, -F], [-1, -F]];
  factories = d.apps.map((a, i) => ({ ...a, cell: fcells[i], acc: 0 }));

  renderHud();
  renderNow();
  renderStrip();
  if (hoverKey) renderTip();
  handleEvents(d);
}

// ---------- alerts: a session finished and is waiting for you ----------

let alertsOn = true;
let seenTs = null;     // events at or before this were already shown
let audio = null;
let bellWasLocked = false;

const audioReady = () => audio && audio.state === 'running';

// Browsers only allow sound after the user has interacted with the page once.
function unlockAudio() {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  }
  if (audio.state === 'suspended') audio.resume().then(renderBell);
  renderBell();
}

function chime() {
  if (!audioReady()) return;
  const t0 = audio.currentTime;
  for (const [freq, at] of [[880, 0], [1318.5, 0.15]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.9);
    o.connect(g).connect(audio.destination);
    o.start(t0 + at);
    o.stop(t0 + at + 1);
  }
}

function renderBell() {
  const bell = $('bell'), locked = alertsOn && !audioReady();
  bell.textContent = alertsOn ? '🔔' : '🔕';
  bell.classList.toggle('off', !alertsOn);
  bell.classList.toggle('locked', locked);
  bell.title = !alertsOn ? '提醒已關閉（點一下開啟）' : locked ? '點一下啟用音效' : '提醒開啟中（點一下關閉）';
}

function handleEvents(d) {
  alertsOn = d.alerts;
  renderBell();
  const evs = d.events || [];
  if (seenTs === null) { seenTs = Math.max(d.now, ...evs.map(e => e.ts)); return; } // don't replay old ones on load
  const fresh = evs.filter(e => e.ts > seenTs);
  if (!fresh.length) return;
  seenTs = Math.max(...fresh.map(e => e.ts));
  if (!alertsOn) return;
  for (const e of fresh) {
    toast(e);
    const b = e.key && blds.get(e.key);
    if (b) b.alertAt = performance.now() / 1000;
  }
  // a throttled tab catching up stays quiet; so does the page while the menu bar app sounds the alert
  // (a phone still rings: you may be away from the Mac)
  if ((!d.menubar || touchUI) && fresh.some(e => Date.now() - e.ts < 15000)) {
    chime();
    if (touchUI && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
}

function toast(e) {
  const box = $('toasts'), el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>◆ ${esc(e.name)}</b>${e.key ? '<span>等你回覆</span>' : ''}<p>${esc(e.text)}</p>`;
  el.addEventListener('click', () => { if (e.key) renderer.focus(e.key); el.remove(); });
  box.prepend(el);
  setTimeout(() => el.classList.add('out'), 10000);
  setTimeout(() => el.remove(), 10600);
  while (box.children.length > 4) box.lastChild.remove();
}

$('bell').addEventListener('pointerdown', () => { bellWasLocked = alertsOn && !audioReady(); });
$('bell').addEventListener('click', async () => {
  if (bellWasLocked) { unlockAudio(); setTimeout(chime, 80); return; } // first click just enables sound
  const r = await fetch('/api/alerts', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !alertsOn }),
  });
  alertsOn = (await r.json()).alerts;
  renderBell();
});
addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', unlockAudio);

async function poll() {
  try {
    // visible=0 when hidden (background tab, folded-up menu bar panel) so the server plays the sound
    const r = await fetch(`/api/state?visible=${document.hidden ? 0 : 1}`, { cache: 'no-store' });
    ingest(await r.json());
  } catch { /* server restarting */ }
  setTimeout(poll, POLL_MS);
}

// ---------- HTML panels ----------

function renderHud() {
  const now = new Date(data.now);
  $('clock').textContent = now.toLocaleTimeString('zh-TW', { hour12: false });
  const n = { work: 0, wait: 0, idle: 0 };
  for (const b of blds.values()) n[b.p.state]++;
  $('n-work').textContent = n.work;
  $('n-wait').textContent = n.wait;
  $('n-idle').textContent = n.idle;
  const m = data.machine;
  gauge('g-cpu', m.cpu, m.cpu > 80 ? COL.hot : m.cpu > 50 ? COL.work : '#5dffa8');
  gauge('g-mem', m.mem, m.mem > 88 ? COL.hot : m.mem > 75 ? COL.work : COL.wait);
  const total = [...blds.values()].reduce((a, b) => a + b.p.energy, 0);
  $('e-total').textContent = compact(total);
}

function gauge(id, v, color) {
  const el = $(id), arc = el.querySelector('.arc'), c = 2 * Math.PI * 21;
  arc.setAttribute('stroke', color);
  arc.setAttribute('stroke-dasharray', `${c * v / 100} ${c}`);
  el.querySelector('.v').textContent = v + '%';
}

function segsHtml(pg) {
  if (!pg) return '';
  const steps = pg.steps.length > 14 ? null : pg.steps;
  const segs = steps ? steps.map(s => `<i class="${s}"></i>`).join('')
    : `<i class="c" style="flex:${pg.done}"></i><i style="flex:${pg.total - pg.done}"></i>`;
  return `<div class="pg"><div class="segs">${segs}</div><span class="num">${pg.done}/${pg.total}</span></div>`;
}

function nowText(p) {
  if (p.progress && p.progress.now) return p.progress.now;
  if (p.state === 'work') return (ACT[p.act] || ACT.mcp)[1] + (p.tool && p.act === 'mcp' ? ' · ' + p.tool.replace(/^mcp__[^_]*__/, '') : '');
  return p.title || p.recap || '';
}

function renderNow() {
  const list = [...blds.values()].filter(b => b.p.state !== 'idle')
    .sort((a, b) => (b.p.state === 'work') - (a.p.state === 'work') || b.p.rate - a.p.rate || b.p.lastTs - a.p.lastTs);
  const idle = [...blds.values()].filter(b => b.p.state === 'idle')
    .sort((a, b) => (a.p.idleMs ?? 9e15) - (b.p.idleMs ?? 9e15));
  // idle bar: log scale from 1 minute to 7 days
  const idleW = ms => clamp(Math.log(Math.max(1, (ms ?? 9e15) / 60000)) / Math.log(7 * 1440), 0.04, 1) * 100;
  const idleHtml = idle.length ? `<div class="sec">💤 閒置</div>` + idle.map(b => `
    <div class="irow${hoverKey === b.key ? ' hl' : ''}" data-key="${esc(b.key)}">
      <i style="background:${b.p.procs ? COL.idle : COL.off}"></i><span class="nm">${esc(b.p.name)}</span>
      <span class="bar"><b style="width:${idleW(b.p.idleMs)}%"></b></span><span class="d num">${dur(b.p.idleMs)}</span>
    </div>`).join('') : '';
  if (!list.length) { $('now').innerHTML = '<div class="quiet">🌙</div>' + idleHtml; return; }
  $('now').innerHTML = list.map(b => {
    const p = b.p;
    const ico = p.state === 'work' ? (ACT[p.act] || ACT.mcp)[0] : '◆';
    const tail = p.state === 'work' ? (p.working > 1 ? `×${p.working}` : '') : dur(p.idleMs);
    return `<div class="card ${p.state}${hoverKey === b.key ? ' hl' : ''}" data-key="${esc(b.key)}">
      <div class="r1"><span class="ico">${ico}</span><span class="nm">${esc(p.name)}</span>
        <span class="e num">${tail ? `<span style="color:var(--dim);margin-right:6px">${tail}</span>` : ''}⚡${compact(p.energy)}</span></div>
      <div class="step">${esc(nowText(p)) || '&nbsp;'}</div>
      ${segsHtml(p.progress)}
    </div>`;
  }).join('') + idleHtml;
}

function renderStrip() {
  const list = [...blds.values()].filter(b => b.p.energy > 0).sort((a, b) => b.p.energy - a.p.energy);
  const total = list.reduce((a, b) => a + b.p.energy, 0) || 1;
  $('e-note').textContent = list.length ? `${list.length} 個專案` : '';
  $('strip').innerHTML = list.map((b, i) => {
    const base = COL[b.kind] === COL.off ? COL.idle : COL[b.kind];
    return `<i data-key="${esc(b.key)}" class="${hoverKey === b.key ? 'hl' : ''}" style="flex-grow:${b.p.energy};background:${shade(base, 1 - (i % 3) * 0.18)}"></i>`;
  }).join('');
  const px = $('strip').clientWidth;
  let x = 0, right = -Infinity, html = '';
  measure.font = FONT(11);
  for (const b of list) {
    const w = b.p.energy / total;
    const text = `${b.p.name} ${compact(b.p.energy)}`;
    const half = measure.measureText(text).width / 2 + 6, mid = (x + w / 2) * px;
    if (w > 0.04 && mid - half > right && mid + half < px) {
      html += `<span style="left:${mid}px">${esc(b.p.name)}<b>${compact(b.p.energy)}</b></span>`;
      right = mid + half;
    }
    x += w;
  }
  $('strip-labels').innerHTML = html;
}

function renderTip(mx, my) {
  const tip = $('tip');
  const b = blds.get(hoverKey);
  if (!b) { tip.hidden = true; return; }
  const p = b.p;
  const stateTxt = { work: '工作中', wait: '等你回覆', idle: p.procs ? '閒置（開著）' : '閒置' }[p.state];
  tip.style.setProperty('--c', COL[b.kind] === COL.off ? COL.idle : COL[b.kind]);
  tip.innerHTML = `
    <h3><span>${esc(p.name)}</span><em>${stateTxt}${p.working > 1 ? ` ×${p.working}` : ''}</em></h3>
    <div class="ttl">${esc(p.title || p.key)}</div>
    ${p.state !== 'idle' && nowText(p) ? `<div class="now">▶ ${esc(nowText(p))}</div>` : ''}
    ${p.progress ? `<div style="margin-bottom:8px;--c:${COL[b.kind]}">${segsHtml(p.progress).replace('class="pg"', 'class="pg" style="margin:0"')}</div>` : ''}
    <div class="grid num">
      <div>⚡ 今日耗能<b>${compact(p.energy)}</b></div>
      <div>🔤 tokens<b>${compact(p.tokens)}</b></div>
      <div>💨 本機 CPU<b>${p.procs ? p.cpu + '%' : '—'}</b></div>
      <div>🧠 記憶體<b>${p.procs ? compact(p.rss / 1048576) + ' MB' : '—'}</b></div>
      <div>⏱ 上次動作<b>${dur(p.idleMs)}</b></div>
      <div>🗂 sessions<b>${p.sessions}${p.subagents ? ` · 🛸${p.subagents}` : ''}</b></div>
    </div>
    ${p.recap && p.state !== 'work' ? `<div class="recap">${esc(p.recap)}</div>` : ''}`;
  tip.hidden = false;
  if (mx != null) {
    const r = tip.getBoundingClientRect();
    tip.style.left = clamp(mx + 16, 8, innerWidth - r.width - 8) + 'px';
    tip.style.top = clamp(my + 16, 8, innerHeight - r.height - 8) + 'px';
  }
}

// ---------- labels (screen space) ----------

const FONT = size => `600 ${size}px -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif`;
const measure = document.createElement('canvas').getContext('2d');

function pill(g, x, y, text, color, size, bg = 'rgba(6,10,22,0.78)') {
  g.font = FONT(size);
  const w = g.measureText(text).width + 10;
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(x - w / 2, y - size + 1, w, size + 6, 6); g.fill();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.fillText(text, x, y + 2);
  g.textAlign = 'left';
  return w;
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function clipW(s, maxW, font) {
  measure.font = font;
  if (measure.measureText(s).width <= maxW) return s;
  let n = s.length;
  while (n > 1 && measure.measureText(s.slice(0, n) + '…').width > maxW) n--;
  return s.slice(0, n) + '…';
}

// Labels are placed by priority; optional ones that would overlap are skipped,
// so a crowded city stays readable (working/waiting/hovered always show).
// proj maps a building/factory to screen px: base(b) under the building, roof(b) above
// its roof effects, factory(f); each returns [x, y] or null when not visible.
function drawLabels(g, t, proj) {
  g.textBaseline = 'alphabetic';
  const specs = [];
  for (const b of blds.values()) {
    const base = proj.base(b);
    if (!base) continue;
    const p = b.p, hov = hoverKey === b.key;
    const color = b.kind === 'off' ? '#6f7b98' : b.kind === 'idle' ? '#98a5c4' : COL[b.kind];
    specs.push({
      type: 'name', b, x: base[0], y: base[1] + 16, color, size: b.kind === 'off' && !hov ? 10 : 11,
      text: clip(p.name, 12) + (p.state === 'work' ? '' : ' · ' + dur(p.idleMs)),
      segs: p.progress && p.progress.total ? Math.min(p.progress.total, 12) : 0,
      prio: (hov ? 1000 : { work: 300, wait: 200, idle: 100, off: 50 }[b.kind]) + Math.log10(1 + p.energy),
      must: hov || b.kind === 'work' || b.kind === 'wait',
    });
    const roof = b.kind === 'work' && proj.roof(b);
    if (roof) {
      specs.push({
        type: 'bubble', b, x: roof[0], y: roof[1] - 34, rx: roof[0], ry: roof[1], size: 12,
        text: clipW(nowText(p), 230, FONT(12)) + (p.working > 1 ? `  ×${p.working}` : ''), prio: 500 + p.rate / 1e6, must: true,
      });
    }
  }
  for (const f of factories) {
    const at = f.cell && proj.factory(f);
    if (!at) continue;
    specs.push({ type: 'name', x: at[0], y: at[1] + 14, size: 10, segs: 0, prio: 60 + f.cpu / 100,
      text: `🏭 ${clip(f.name, 14)} ${f.cpu}%`, color: f.cpu > 60 ? COL.hot : '#c9a89a' });
  }

  const placed = [];
  const fits = r => !placed.some(q => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
  for (const s of specs.sort((a, b) => b.prio - a.prio)) {
    g.font = FONT(s.size);
    const w = g.measureText(s.text).width + (s.type === 'bubble' ? 16 : 10);
    const rect = s.type === 'bubble'
      ? { x: s.x - w / 2, y: s.y - 15, w, h: 22 }
      : { x: s.x - w / 2, y: s.y - s.size + 1, w, h: s.size + 6 + (s.segs ? 8 : 0) };
    const tries = s.type === 'bubble' ? [0, -26, -52, -78] : [0, 14, -14, 28];
    let dy = tries.find(d => fits({ ...rect, y: rect.y + d }));
    if (dy === undefined) { if (!s.must) continue; dy = 0; }
    placed.push({ ...rect, y: rect.y + dy });
    if (s.type === 'bubble') drawBubble(g, s, w, dy);
    else drawName(g, s, dy, t);
  }
}

function drawName(g, s, dy, t) {
  const y = s.y + dy;
  pill(g, s.x, y, s.text, s.color, s.size);
  if (!s.segs) return;
  const pg = s.b.p.progress, n = s.segs, w = 5, gap = 2, tw = n * (w + gap) - gap;
  const done = Math.round(pg.done / pg.total * n);
  const cur = pg.total <= 12 ? pg.steps.indexOf('i') : -1;
  for (let i = 0; i < n; i++) {
    g.fillStyle = i < done || (i === cur && Math.sin(t * 6) > 0) ? s.color : 'rgba(140,160,210,0.22)';
    g.fillRect(s.x - tw / 2 + i * (w + gap), y + 10, w, 3);
  }
}

function drawBubble(g, s, w, dy) {
  const by = s.y + dy;
  g.strokeStyle = rgba(COL.work, 0.45);
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(s.x, by + 12); g.lineTo(s.rx, s.ry); g.stroke();
  g.fillStyle = 'rgba(30,20,8,0.9)';
  g.strokeStyle = rgba(COL.work, 0.85);
  g.beginPath(); g.roundRect(s.x - w / 2, by - 15, w, 22, 8); g.fill(); g.stroke();
  g.fillStyle = '#ffe7bf';
  g.font = FONT(s.size);
  g.textAlign = 'center';
  g.fillText(s.text, s.x, by);
  g.textAlign = 'left';
}

// ---------- interaction (panels) ----------

function setHover(key, mx, my) {
  if (key !== hoverKey) {
    hoverKey = key;
    document.querySelectorAll('[data-key]').forEach(el => el.classList.toggle('hl', el.dataset.key === key));
  }
  if (key) renderTip(mx, my); else $('tip').hidden = true;
}

for (const id of ['now', 'strip']) {
  $(id).addEventListener('mouseover', e => {
    const el = e.target.closest('[data-key]');
    if (el) setHover(el.dataset.key, e.clientX, e.clientY);
  });
  $(id).addEventListener('mouseleave', () => setHover(null));
  $(id).addEventListener('click', e => {
    const el = e.target.closest('[data-key]');
    if (!el) return;
    renderer.focus(el.dataset.key);
    if (touchUI) setHover(el.dataset.key);
  });
}
$('help').addEventListener('click', () => { $('legend').hidden = !$('legend').hidden; });
// touch: the info card stays up until you tap it, which also flies back to the whole city
$('tip').addEventListener('click', () => { setHover(null); renderer.focus(null); });
$('grip').addEventListener('click', () => {
  document.body.classList.toggle('sheet-min');
  setTimeout(() => dispatchEvent(new Event('resize')), 320); // re-centre the city once the sheet has moved
});

// ---------- renderer: 3D by default, 2D on request or when 3D can't load ----------

function loadRenderer() {
  let mode = new URLSearchParams(location.search).get('v');
  try { mode = mode || localStorage.getItem('city-mode'); } catch { /* storage blocked */ }
  mode = mode === '2d' ? '2d' : '3d';
  document.body.dataset.mode = mode;
  $('mode').textContent = mode === '3d' ? '2D' : '3D';
  const s = document.createElement('script');
  if (mode === '3d') {
    s.type = 'module';
    s.src = 'city3d.js';
    s.onerror = () => { location.search = '?v=2d'; }; // three.js comes from a CDN; offline falls back
  } else {
    s.src = 'city2d.js';
  }
  document.body.appendChild(s);
}

$('mode').addEventListener('click', () => {
  const next = document.body.dataset.mode === '3d' ? '2d' : '3d';
  try { localStorage.setItem('city-mode', next); } catch { /* storage blocked */ }
  const q = new URLSearchParams(location.search); // keep the phone's ?k= key
  q.set('v', next);
  location.search = q;
});

loadRenderer();
poll();
