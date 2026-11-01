'use strict';
// Claude 戰情城 — 2D isometric renderer drawn on canvas.
// One building per project: height = today's energy, animation = current activity,
// chimney smoke = local CPU, power line pulses = tokens being spent.

const TW = 150, TH = 75;          // iso tile size at zoom 1
const PAL = {
  work: { body: '#2c2244', win: '#ffc76e' },
  wait: { body: '#12293f', win: '#8ceaff' },
  idle: { body: '#1b2235', win: '#b8c3de' },
  off: { body: '#141a28', win: '#6d7891' },
};

const cv = $('city');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;

let particles = [];
let pulses = [];
let cars = [];
const view = { z0: 1, user: 1, px: 0, py: 0, goal: null };

// ---------- helpers ----------

const iso = (gx, gy, z = 0) => [(gx - gy) * TW / 2, (gx + gy) * TH / 2 - z];

function poly(pts, fill) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const heightFor = e => Math.min(240, 22 + 44 * Math.log10(1 + e / 20000));

function litFrac(b) {
  if (b.kind === 'work') return 0.85;
  if (b.kind === 'wait') return 0.62;
  const hrs = (b.p.idleMs ?? 9e9) / 3.6e6;
  return (b.kind === 'idle' ? 0.4 : 0.2) * Math.exp(-hrs / 6) + 0.04;
}

// ---------- view ----------

function fitView() {
  const G = ringR + 1.1; // let the empty rim bleed off-screen a little
  view.z0 = Math.min((W - panelW() - 40) / (2 * G * TW), (H - 160 - (phone() ? sheetH() - 40 : 0)) / (2 * G * TH + 150));
}

function origin() {
  return [panelW() + (W - panelW()) / 2 + view.px, H / 2 + 50 + view.py - (phone() ? (sheetH() - 60) / 2 : 0)];
}

const zoom = () => view.z0 * view.user;

function toScreen(p) {
  const [ox, oy] = origin(), z = zoom();
  return [ox + p[0] * z, oy + p[1] * z];
}

function toWorld(x, y) {
  const [ox, oy] = origin(), z = zoom();
  return [(x - ox) / z, (y - oy) / z];
}

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  fitView();
}

// 2D-only per-building state, added the first time we see a building
function prep(b) {
  if (b.acc) return;
  Object.assign(b, { h: 0, flash: 0, acc: { smoke: 0, spark: 0, z: 0 } });
}

function burst(b, de) {
  prep(b);
  b.flash = 1;
  b.acc.spark += Math.min(26, 4 + Math.log10(de) * 3);
  if (!b.p.procs) return;
  const n = clamp(Math.round(Math.log10(de) - 2), 1, 6);
  for (let i = 0; i < n; i++) pulses.push({ b, t: -i * 0.2, dur: 1.2 });
}

// ---------- simulation ----------

function spawn(o) { if (particles.length < 900) particles.push(o); }

function chimneyTop(b) { return iso(b.cell[0] - 0.19, b.cell[1] - 0.19, b.h + 13); }
const roofCenter = b => iso(b.cell[0], b.cell[1], b.h);
const plantTop = () => iso(0, 0, 76);

function update(dt, t) {
  for (const b of blds.values()) {
    prep(b);
    b.h += (heightFor(b.p.energy) - b.h) * Math.min(1, dt * 2.2);
    b.flash = Math.max(0, b.flash - dt * 1.5);
    const p = b.p;
    if (p.procs && p.cpu > 0.5) {
      b.acc.smoke += dt * Math.min(14, 0.5 + p.cpu / 7);
      while (b.acc.smoke >= 1) {
        b.acc.smoke--;
        const [x, y] = chimneyTop(b);
        const hot = p.cpu > 60;
        spawn({ k: 'smoke', x: x + rand(-1, 1), y, vx: rand(4, 10), vy: rand(-22, -14), life: 0, max: rand(2.4, 3.8),
          r0: 2.5, r1: 9 + Math.min(14, p.cpu / 8), c: hot ? '255,120,96' : '176,186,208' });
      }
    }
    if (b.kind === 'work' && p.act === 'bash') b.acc.spark += dt * 6;
    while (b.acc.spark >= 1) {
      b.acc.spark--;
      const [x, y] = roofCenter(b);
      spawn({ k: 'spark', x: x + rand(-14, 14), y: y - rand(4, 20), vx: rand(-30, 30), vy: rand(-70, -25), ay: 90,
        life: 0, max: rand(0.6, 1.2), c: Math.random() < 0.5 ? COL.energy : COL.work });
    }
    if (b.kind === 'idle' && (p.idleMs ?? 0) > 30 * 60000) {
      b.acc.z += dt * 0.3;
      if (b.acc.z >= 1) {
        b.acc.z = 0;
        const [x, y] = roofCenter(b);
        spawn({ k: 'z', x: x + 6, y: y - 6, vx: rand(4, 8), vy: -10, life: 0, max: 3.2 });
      }
    }
  }
  if (data) {
    const cpu = data.machine.cpu;
    if (Math.random() < dt * (1 + cpu / 6)) {
      const [x, y] = plantTop();
      spawn({ k: 'smoke', x: x + rand(-8, 8), y: y + 4, vx: rand(3, 8), vy: rand(-20, -12), life: 0, max: rand(2.5, 4),
        r0: 4, r1: 14, c: '205,225,255' });
    }
    for (const f of factories) {
      if (!f.cell) continue;
      f.acc += dt * Math.min(10, f.cpu / 6);
      while (f.acc >= 1) {
        f.acc--;
        const side = Math.random() < 0.5 ? -0.2 : 0.05;
        const [x, y] = iso(f.cell[0] + side, f.cell[1] - 0.18, 52);
        spawn({ k: 'smoke', x, y, vx: rand(4, 9), vy: rand(-20, -12), life: 0, max: rand(2.5, 4),
          r0: 3, r1: 11 + Math.min(14, f.cpu / 8), c: f.cpu > 60 ? '255,120,96' : '150,150,160' });
      }
    }
  }
  for (const p of particles) {
    p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.ay) p.vy += p.ay * dt;
  }
  particles = particles.filter(p => p.life < p.max);
  for (const q of pulses) q.t += dt / q.dur;
  pulses = pulses.filter(q => q.t < 1 && blds.has(q.b.key));

  // traffic grows with the number of working projects
  const working = [...blds.values()].filter(b => b.kind === 'work').length;
  const want = 6 + working * 7;
  while (cars.length < want) cars.push(newCar());
  if (cars.length > want) cars.length = want;
  const G = ringR + 1.5;
  for (const c of cars) {
    c.pos += c.dir * c.speed * dt;
    if (c.pos > G || c.pos < -G) Object.assign(c, newCar());
  }

  if (view.goal) {
    view.px += (view.goal[0] - view.px) * Math.min(1, dt * 4);
    view.py += (view.goal[1] - view.py) * Math.min(1, dt * 4);
    if (Math.hypot(view.goal[0] - view.px, view.goal[1] - view.py) < 1) view.goal = null;
  }
}

function newCar() {
  const G = ringR + 1.5;
  const lanes = [];
  for (let k = -ringR - 2; k <= ringR + 1; k++) lanes.push(k + 0.5);
  const dir = Math.random() < 0.5 ? 1 : -1;
  return { vert: Math.random() < 0.5, lane: lanes[Math.floor(Math.random() * lanes.length)] + dir * 0.05,
    pos: rand(-G, G), dir, speed: rand(0.25, 0.6) };
}

// ---------- drawing: scenery ----------

const stars = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random() * 0.75, s: rand(0.4, 1.4), ph: rand(0, 6), sp: rand(0.5, 2) }));

function drawSky(t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#03050c');
  g.addColorStop(0.55, '#081022');
  g.addColorStop(1, '#0f1830');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const s of stars) {
    ctx.globalAlpha = 0.25 + 0.55 * Math.sin(t * s.sp + s.ph) ** 2;
    ctx.fillStyle = '#cfe0ff';
    ctx.fillRect(s.x * W, s.y * H, s.s, s.s);
  }
  ctx.globalAlpha = 1;
  if (!data) return;
  // the city glows warmer the more it works; the sky reddens when the Mac is under load
  const working = [...blds.values()].filter(b => b.kind === 'work').length;
  const [ox, oy] = origin();
  const rg = ctx.createRadialGradient(ox, oy, 10, ox, oy, Math.max(W, H) * 0.6);
  rg.addColorStop(0, `rgba(255,170,80,${Math.min(0.16, 0.04 + working * 0.03)})`);
  rg.addColorStop(1, 'rgba(255,170,80,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);
  const cpu = data.machine.cpu;
  if (cpu > 50) {
    ctx.fillStyle = `rgba(255,60,50,${(cpu - 50) / 50 * 0.12})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawGround(t) {
  const G = ringR + 1.5;
  const N = iso(-G, -G), E = iso(G, -G), S = iso(G, G), Wc = iso(-G, G);
  const slab = 18;
  poly([Wc, S, [S[0], S[1] + slab], [Wc[0], Wc[1] + slab]], '#0b1120');
  poly([S, E, [E[0], E[1] + slab], [S[0], S[1] + slab]], '#0e1528');
  const g = ctx.createLinearGradient(0, N[1], 0, S[1]);
  g.addColorStop(0, '#0a1122');
  g.addColorStop(1, '#111b33');
  poly([N, E, S, Wc], g);
  ctx.strokeStyle = 'rgba(90,130,210,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.lineCap = 'butt';
  for (let k = -ringR - 2; k <= ringR + 1; k++) {
    const v = k + 0.5;
    for (const [a, b] of [[iso(v, -G), iso(v, G)], [iso(-G, v), iso(G, v)]]) {
      ctx.strokeStyle = 'rgba(22,32,56,0.95)';
      ctx.lineWidth = 11;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(120,150,210,0.13)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 9]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // cars: white headlight in front, red tail light behind
  for (const c of cars) {
    const at = s => (c.vert ? iso(c.lane, s) : iso(s, c.lane));
    const f = at(c.pos + c.dir * 0.035), r = at(c.pos - c.dir * 0.035);
    ctx.fillStyle = 'rgba(255,245,220,0.95)';
    ctx.fillRect(f[0] - 1.2, f[1] - 1.2, 2.4, 2.4);
    ctx.fillStyle = 'rgba(255,70,70,0.85)';
    ctx.fillRect(r[0] - 1, r[1] - 1, 2, 2);
  }
}

function drawGlows(t) {
  ctx.globalCompositeOperation = 'lighter';
  for (const b of blds.values()) {
    const [x, y] = iso(b.cell[0], b.cell[1]);
    let col = null, a = 0;
    if (b.kind === 'work') { col = '255,170,70'; a = 0.32 + 0.12 * Math.sin(t * 3 + b.id); }
    else if (b.kind === 'wait') { col = '63,224,255'; a = 0.16 + 0.08 * Math.sin(t * 1.5 + b.id); }
    if (b.p.procs && b.p.cpu > 40) { col = '255,90,70'; a = Math.min(0.5, b.p.cpu / 200); }
    if (!col) continue;
    ctx.save();
    ctx.translate(x, y); ctx.scale(1, 0.5);
    const rg = ctx.createRadialGradient(0, 0, 4, 0, 0, 70);
    rg.addColorStop(0, `rgba(${col},${a})`);
    rg.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(0, 0, 70, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function linePoints(b) {
  const a = plantTop(), c = iso(b.cell[0], b.cell[1], b.h + 2);
  const m = [(a[0] + c[0]) / 2, Math.min(a[1], c[1]) - 40];
  return [a, m, c];
}

function bez([a, m, c], s) {
  const u = 1 - s;
  return [u * u * a[0] + 2 * u * s * m[0] + s * s * c[0], u * u * a[1] + 2 * u * s * m[1] + s * s * c[1]];
}

function drawLines(t) {
  for (const b of blds.values()) {
    if (!b.p.procs) continue;
    const [a, m, c] = linePoints(b);
    const col = b.kind === 'work' ? COL.work : b.kind === 'wait' ? COL.wait : COL.idle;
    ctx.strokeStyle = rgba(col, b.kind === 'work' ? 0.55 : 0.25);
    ctx.lineWidth = b.kind === 'work' ? 1.6 : 1;
    ctx.setLineDash([3, 9]);
    ctx.lineDashOffset = -t * (8 + b.p.cpu * 0.8 + (b.kind === 'work' ? 30 : 0));
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(m[0], m[1], c[0], c[1]); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawPulses() {
  ctx.globalCompositeOperation = 'lighter';
  for (const q of pulses) {
    if (q.t < 0) continue;
    const pts = linePoints(q.b);
    for (let i = 0; i < 6; i++) {
      const s = q.t - i * 0.025;
      if (s < 0) break;
      const [x, y] = bez(pts, s);
      ctx.fillStyle = rgba(COL.energy, 0.9 - i * 0.15);
      ctx.beginPath(); ctx.arc(x, y, 3.2 - i * 0.4, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawParticles() {
  for (const p of particles) {
    const k = p.life / p.max;
    if (p.k === 'smoke') {
      const a = Math.min(1, k * 6) * (1 - k) * 0.32;
      ctx.fillStyle = `rgba(${p.c},${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r0 + k * p.r1, 0, Math.PI * 2); ctx.fill();
    } else if (p.k === 'spark') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(p.c, 1 - k);
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 * (1 - k) + 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else if (p.k === 'z') {
      ctx.fillStyle = `rgba(160,176,216,${(1 - k) * 0.7})`;
      ctx.font = `600 ${8 + k * 6}px -apple-system, sans-serif`;
      ctx.fillText('z', p.x, p.y);
    }
  }
}

// ---------- drawing: structures ----------

function box(cx, cy, a, h, col, z0 = 0) {
  const g = (x, y, z) => iso(x, y, z);
  const Wg = g(cx - a, cy + a, z0), Sg = g(cx + a, cy + a, z0), Eg = g(cx + a, cy - a, z0);
  const Wt = g(cx - a, cy + a, z0 + h), St = g(cx + a, cy + a, z0 + h), Et = g(cx + a, cy - a, z0 + h), Nt = g(cx - a, cy - a, z0 + h);
  poly([Wg, Sg, St, Wt], shade(col, 0.8));
  poly([Sg, Eg, Et, St], shade(col, 1.15));
  poly([Nt, Et, St, Wt], shade(col, 1.6));
  return { Wg, Sg, Eg, Wt, St, Et, Nt };
}

function windows(b, A, B, h, t, face) {
  const cols = 3, floors = Math.max(1, Math.floor((h - 10) / 12));
  const frac = litFrac(b);
  const lit = new Path2D(), dim = new Path2D();
  const at = (u, z) => [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u - z];
  for (let r = 0; r < floors; r++) {
    for (let c = 0; c < cols; c++) {
      const seed = hash(b.id, face, r, c);
      const on = b.kind === 'work'
        ? hash(b.id, face, r, c, Math.floor(t * (0.5 + seed * 1.8) + seed * 10)) < frac
        : seed < frac;
      const u0 = (c + 0.22) / cols, u1 = (c + 0.78) / cols, z0 = 7 + r * 12, z1 = z0 + 6;
      const q = [at(u0, z0), at(u1, z0), at(u1, z1), at(u0, z1)];
      const path = on ? lit : dim;
      path.moveTo(q[0][0], q[0][1]);
      for (let i = 1; i < 4; i++) path.lineTo(q[i][0], q[i][1]);
      path.closePath();
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill(dim);
  ctx.fillStyle = PAL[b.kind].win;
  ctx.globalAlpha = face ? 0.95 : 0.78;
  if (b.kind === 'work' || b.kind === 'wait') { ctx.shadowColor = PAL[b.kind].win; ctx.shadowBlur = 6; }
  ctx.fill(lit);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function hull(b) {
  const [cx, cy] = b.cell, a = 0.3, h = b.h;
  return [iso(cx - a, cy + a), iso(cx + a, cy + a), iso(cx + a, cy - a), iso(cx + a, cy - a, h), iso(cx - a, cy - a, h), iso(cx - a, cy + a, h)];
}

function drawBuilding(b, t) {
  const [cx, cy] = b.cell, a = 0.3, h = Math.max(1, b.h);
  const pal = PAL[b.kind];
  const edge = b.kind === 'off' ? COL.off : COL[b.kind];
  poly([iso(cx - 0.42, cy + 0.42), iso(cx + 0.42, cy + 0.42), iso(cx + 0.42, cy - 0.42), iso(cx - 0.42, cy - 0.42)], 'rgba(120,140,200,0.07)');
  const f = box(cx, cy, a, h, pal.body);
  windows(b, f.Wg, f.Sg, h, t, 0);
  windows(b, f.Sg, f.Eg, h, t, 1);

  if (b.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    poly([f.Wg, f.Sg, f.Eg, f.Et, f.Nt, f.Wt], rgba(COL.energy, b.flash * 0.22));
    ctx.globalCompositeOperation = 'source-over';
  }
  // neon roof outline + front edge
  ctx.strokeStyle = edge;
  ctx.lineWidth = hoverKey === b.key ? 2.4 : 1.2;
  if (b.kind === 'work' || b.kind === 'wait' || hoverKey === b.key) { ctx.shadowColor = edge; ctx.shadowBlur = 10; }
  poly([f.Nt, f.Et, f.St, f.Wt]);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(f.Sg[0], f.Sg[1]); ctx.lineTo(f.St[0], f.St[1]); ctx.stroke();
  ctx.shadowBlur = 0;

  if (b.p.procs) box(cx - 0.19, cy - 0.19, 0.045, 13, '#3a3f52', h);

  if (b.kind === 'work') {
    ({ bash: fxBash, edit: fxEdit, read: fxRead, web: fxWeb, agent: fxThink, think: fxThink, mcp: fxMcp }[b.p.act] || fxMcp)(b, t);
  } else if (b.kind === 'wait') fxWait(b, t);
  const drones = b.kind === 'work' && b.p.act === 'agent' ? Math.max(2, b.p.subagents) : b.p.subagents;
  if (drones) fxDrones(b, t, drones);
  const since = t - (b.alertAt ?? -99);
  if (since < 5) fxAlert(b, since);
}

// "done, your turn": a cyan beam and rings for a few seconds
function fxAlert(b, since) {
  const [x, y] = roofCenter(b), fade = 1 - since / 5;
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(x, y, x, y - 320);
  g.addColorStop(0, rgba(COL.wait, 0.55 * fade));
  g.addColorStop(1, rgba(COL.wait, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - 7, y - 320, 14, 320);
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 3; i++) {
    const k = (since * 0.8 + i / 3) % 1, r = 10 + k * 80;
    ctx.strokeStyle = rgba(COL.wait, (1 - k) * fade);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
  }
}

function fxBash(b, t) {
  const [x, y] = roofCenter(b);
  ctx.strokeStyle = '#8a7a64'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 14); ctx.stroke();
  gear(x, y - 22, 9, t * 2.6, COL.work);
  gear(x + 13, y - 15, 5.5, -t * 4.2, '#ffd890');
}

function gear(x, y, r, ang, col) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  ctx.beginPath();
  for (let i = 0; i < 16; i++) {
    const rr = i % 2 ? r : r * 1.32;
    const a0 = i / 16 * Math.PI * 2, a1 = (i + 1) / 16 * Math.PI * 2;
    ctx.lineTo(Math.cos(a0) * rr, Math.sin(a0) * rr);
    ctx.lineTo(Math.cos(a1) * rr, Math.sin(a1) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#2c2244';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.38, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function fxEdit(b, t) {
  const [cx, cy] = b.cell, h = b.h, mx = cx - 0.1, my = cy - 0.1, mast = 40;
  const base = iso(mx, my, h), top = iso(mx, my, h + mast);
  ctx.strokeStyle = COL.work; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(base[0] - 2, base[1]); ctx.lineTo(top[0] - 2, top[1]); ctx.moveTo(base[0] + 2, base[1]); ctx.lineTo(top[0] + 2, top[1]); ctx.stroke();
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let z = 0; z < mast; z += 8) { const p = iso(mx, my, h + z), q = iso(mx, my, h + z + 8); ctx.moveTo(p[0] - 2, p[1]); ctx.lineTo(q[0] + 2, q[1]); }
  ctx.stroke();
  const th = 0.7 + Math.sin(t * 0.55) * 1.3;
  const end = iso(mx + Math.cos(th) * 0.6, my + Math.sin(th) * 0.6, h + mast);
  const back = iso(mx - Math.cos(th) * 0.22, my - Math.sin(th) * 0.22, h + mast);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(back[0], back[1]); ctx.lineTo(end[0], end[1]); ctx.stroke();
  ctx.fillStyle = '#8a6a3a'; ctx.fillRect(back[0] - 4, back[1] - 2, 8, 6);
  const drop = 16 + Math.sin(t * 1.6) * 8;
  ctx.strokeStyle = 'rgba(255,220,160,0.7)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(end[0], end[1]); ctx.lineTo(end[0], end[1] + drop); ctx.stroke();
  ctx.fillStyle = '#ffd890'; ctx.fillRect(end[0] - 4, end[1] + drop, 8, 6);
  if (Math.sin(t * 6) > 0) { ctx.fillStyle = COL.hot; ctx.beginPath(); ctx.arc(top[0], top[1] - 2, 2, 0, Math.PI * 2); ctx.fill(); }
}

function fxRead(b, t) {
  const [x, y0] = roofCenter(b), y = y0 - 5;
  const ang = -Math.PI / 2 + Math.sin(t * 0.9 + b.id) * 0.75, len = 170, sp = 0.13;
  const g = ctx.createLinearGradient(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
  g.addColorStop(0, 'rgba(255,236,190,0.42)');
  g.addColorStop(1, 'rgba(255,236,190,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(ang - sp) * len, y + Math.sin(ang - sp) * len);
  ctx.lineTo(x + Math.cos(ang + sp) * len, y + Math.sin(ang + sp) * len);
  ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff4d8';
  ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
}

function fxWeb(b, t) {
  const [x, y] = roofCenter(b), top = y - 32;
  ctx.strokeStyle = '#a89070'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.moveTo(x - 6, y - 12); ctx.lineTo(x + 6, y - 12); ctx.moveTo(x - 4, y - 22); ctx.lineTo(x + 4, y - 22); ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.7 + i / 3) % 1, r = 5 + k * 44;
    ctx.strokeStyle = rgba(COL.work, (1 - k) * 0.8); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, top, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = Math.sin(t * 8) > 0 ? '#fff' : COL.work;
  ctx.beginPath(); ctx.arc(x, top, 2.5, 0, Math.PI * 2); ctx.fill();
}

function fxThink(b, t) {
  const [x, y] = roofCenter(b), oy = y - 24 + Math.sin(t * 2) * 2.5;
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(x, oy, 1, x, oy, 20);
  rg.addColorStop(0, 'rgba(255,200,110,0.65)');
  rg.addColorStop(1, 'rgba(255,200,110,0)');
  ctx.fillStyle = rg;
  ctx.beginPath(); ctx.arc(x, oy, 20, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff3d6';
  ctx.beginPath(); ctx.arc(x, oy, 4.5 + Math.sin(t * 4) * 0.8, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 3; i++) {
    const a = t * 3 + i * 2.094;
    ctx.fillStyle = COL.work;
    ctx.beginPath(); ctx.arc(x + Math.cos(a) * 13, oy + Math.sin(a) * 5, 1.8, 0, Math.PI * 2); ctx.fill();
  }
}

function fxMcp(b, t) {
  const [x, y] = roofCenter(b), top = y - 16;
  ctx.strokeStyle = '#8a7a64'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  const a = t * 3;
  ctx.globalCompositeOperation = 'lighter';
  for (const s of [1, -1]) {
    const g = ctx.createLinearGradient(x, top, x + s * Math.cos(a) * 60, top);
    g.addColorStop(0, 'rgba(255,190,90,0.5)'); g.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = g;
    const w = Math.cos(a) * 60 * s;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + w, top - 7); ctx.lineTo(x + w, top + 7); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffe2a8';
  ctx.beginPath(); ctx.arc(x, top, 3.5, 0, Math.PI * 2); ctx.fill();
}

function fxWait(b, t) {
  const [x, y] = roofCenter(b);
  const k = (t * 0.8 + b.id * 0.3) % 1;
  ctx.strokeStyle = rgba(COL.wait, (1 - k) * 0.7); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(x, y, 8 + k * 26, (8 + k * 26) * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
  const my = y - 28 - Math.abs(Math.sin(t * 2.2 + b.id)) * 9;
  ctx.fillStyle = COL.wait; ctx.shadowColor = COL.wait; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.moveTo(x, my - 9); ctx.lineTo(x + 6, my); ctx.lineTo(x, my + 9); ctx.lineTo(x - 6, my); ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.moveTo(x, my - 9); ctx.lineTo(x + 6, my); ctx.lineTo(x, my); ctx.closePath(); ctx.fill();
}

function fxDrones(b, t, n) {
  const [cx, cy] = b.cell, [rx, ry] = roofCenter(b);
  for (let i = 0; i < n; i++) {
    const a = t * 1.1 + i * Math.PI * 2 / n;
    const [x, y] = iso(cx + Math.cos(a) * 0.55, cy + Math.sin(a) * 0.55, b.h + 30 + Math.sin(t * 3 + i) * 4);
    ctx.strokeStyle = 'rgba(255,220,160,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = '#d8deef'; ctx.fillRect(x - 5, y - 1.5, 10, 3);
    ctx.strokeStyle = 'rgba(216,222,239,0.6)';
    const w = 4 + Math.sin(t * 40 + i) * 2;
    ctx.beginPath(); ctx.moveTo(x - 6 - w, y - 3); ctx.lineTo(x - 6 + w, y - 3); ctx.moveTo(x + 6 - w, y - 3); ctx.lineTo(x + 6 + w, y - 3); ctx.stroke();
    ctx.fillStyle = Math.sin(t * 6 + i) > 0 ? COL.hot : '#5dffa8';
    ctx.fillRect(x - 1, y + 1.5, 2, 2);
  }
}

function drawPlant(t) {
  if (!data) return;
  const { cpu, mem } = data.machine;
  box(0, 0, 0.44, 8, '#1a2134');
  const [x, y] = iso(0, 0, 8), rx = 30, ry = 15, hh = 46;
  const side = ctx.createLinearGradient(x - rx, 0, x + rx, 0);
  side.addColorStop(0, '#141b2d'); side.addColorStop(0.55, '#2d3958'); side.addColorStop(1, '#161d30');
  ctx.fillStyle = side;
  ctx.beginPath();
  ctx.moveTo(x - rx, y - hh); ctx.lineTo(x - rx, y);
  ctx.ellipse(x, y, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(x + rx, y - hh); ctx.closePath(); ctx.fill();
  // memory = liquid level in the tank
  const lv = hh * mem / 100;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - rx, y - lv); ctx.lineTo(x - rx, y); ctx.ellipse(x, y, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(x + rx, y - lv);
  ctx.ellipse(x, y - lv, rx, ry, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.fillStyle = rgba(mem > 88 ? COL.hot : COL.wait, 0.22);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#26304b';
  ctx.beginPath(); ctx.ellipse(x, y - hh, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(120,160,230,0.35)'; ctx.lineWidth = 1; ctx.stroke();

  const hue = 140 - clamp(cpu, 0, 100) * 1.4;
  const core = `hsl(${hue},95%,62%)`, cy = y - hh - 20 + Math.sin(t * 1.5) * 2;
  ctx.globalCompositeOperation = 'lighter';
  const rg = ctx.createRadialGradient(x, cy, 2, x, cy, 42);
  rg.addColorStop(0, `hsla(${hue},95%,62%,0.7)`); rg.addColorStop(1, `hsla(${hue},95%,62%,0)`);
  ctx.fillStyle = rg;
  ctx.beginPath(); ctx.arc(x, cy, 42, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(x, cy, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.arc(x - 3, cy - 3, 3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = core; ctx.lineWidth = 1.6;
  ctx.setLineDash([7, 6]);
  ctx.lineDashOffset = -t * (12 + cpu * 1.6);
  ctx.beginPath(); ctx.ellipse(x, cy, 26, 9, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineDashOffset = t * (8 + cpu);
  ctx.beginPath(); ctx.ellipse(x, cy, 20, 12, Math.PI / 3, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}

function drawFactory(f, t) {
  const [cx, cy] = f.cell;
  const fb = box(cx, cy, 0.36, 22, '#2a2128');
  for (let i = 0; i < 3; i++) { // saw-tooth roof
    const u = -0.36 + i * 0.24;
    const p0 = iso(cx + u, cy + 0.36, 22), p1 = iso(cx + u + 0.24, cy + 0.36, 22), pk = iso(cx + u + 0.24, cy + 0.36, 34);
    const q0 = iso(cx + u, cy - 0.36, 22), qk = iso(cx + u + 0.24, cy - 0.36, 34);
    poly([p0, pk, qk, q0], '#3a2e36');
    poly([p0, p1, pk], '#4a3a42');
  }
  box(cx - 0.2, cy - 0.18, 0.05, 30, '#4a3a42', 22);
  box(cx + 0.05, cy - 0.18, 0.05, 30, '#4a3a42', 22);
  const glow = clamp(f.cpu / 100, 0.15, 1);
  ctx.fillStyle = `rgba(255,150,70,${glow * 0.8})`;
  for (let i = 0; i < 4; i++) {
    const u = (i + 0.3) / 4;
    const p = [fb.Sg[0] + (fb.Eg[0] - fb.Sg[0]) * u, fb.Sg[1] + (fb.Eg[1] - fb.Sg[1]) * u - 9];
    ctx.fillRect(p[0] - 3, p[1] - 3, 6, 5);
  }
}

// ---------- frame ----------

function draw(t) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawSky(t);
  if (!data) return;
  const [ox, oy] = origin(), z = zoom();
  ctx.setTransform(DPR * z, 0, 0, DPR * z, DPR * ox, DPR * oy);
  drawGround(t);
  drawGlows(t);
  drawLines(t);
  const items = [{ d: 0, draw: () => drawPlant(t) }];
  for (const b of blds.values()) items.push({ d: b.cell[0] + b.cell[1], draw: () => drawBuilding(b, t) });
  for (const f of factories) if (f.cell) items.push({ d: f.cell[0] + f.cell[1], draw: () => drawFactory(f, t) });
  items.sort((a, b) => a.d - b.d).forEach(i => i.draw());
  drawPulses();
  drawParticles();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawLabels(ctx, t, proj2d);
}

const proj2d = {
  base: b => toScreen(iso(b.cell[0] + 0.3, b.cell[1] + 0.3)),
  roof: b => { const [x, y] = toScreen(roofCenter(b)); return [x, y - 30 * Math.min(1.4, zoom())]; },
  factory: f => toScreen(iso(f.cell[0] + 0.36, f.cell[1] + 0.36)),
};

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000); // tolerate throttled background tabs
  last = now;
  update(dt, now / 1000);
  draw(now / 1000);
  requestAnimationFrame(frame);
}

// ---------- interaction ----------

function pick(mx, my) {
  const [wx, wy] = toWorld(mx, my);
  let best = null;
  for (const b of blds.values()) {
    if (inPoly(wx, wy, hull(b)) && (!best || b.cell[0] + b.cell[1] > best.cell[0] + best.cell[1])) best = b;
  }
  return best;
}

function focus(key) {
  const b = blds.get(key);
  if (!b) return;
  const p = iso(b.cell[0], b.cell[1], b.h / 2), z = zoom();
  view.goal = [-p[0] * z, -(p[1] * z + 50) + 40];
}

let drag = null;
cv.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, px: view.px, py: view.py, moved: false }; });
addEventListener('mouseup', () => { drag = null; cv.classList.remove('drag'); });
cv.addEventListener('mousemove', e => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; cv.classList.add('drag'); view.goal = null; }
    view.px = drag.px + dx; view.py = drag.py + dy;
    return;
  }
  const b = pick(e.clientX, e.clientY);
  setHover(b ? b.key : null, e.clientX, e.clientY);
});
cv.addEventListener('mouseleave', () => setHover(null));
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const [ox, oy] = origin();
  const nz = clamp(view.user * Math.exp(-e.deltaY * 0.0015), 0.5, 4), k = nz / view.user;
  view.px += (e.clientX - ox) * (1 - k);
  view.py += (e.clientY - oy) * (1 - k);
  view.user = nz;
  view.goal = null;
}, { passive: false });
cv.addEventListener('dblclick', () => { view.user = 1; view.goal = [0, 0]; });

Object.assign(renderer, { burst, focus, layout: () => { fitView(); cars = []; } });
addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);

