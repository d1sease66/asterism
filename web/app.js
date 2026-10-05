// Asterism dashboard. Vanilla JS, one rAF loop per canvas, data from
// /api/public/* (already delayed server-side). No invented numbers: when a
// source is empty the page says so.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => 1 - Math.pow(1 - clamp(t), 3);
const DPR = () => Math.min(2, window.devicePixelRatio || 1);

// ---------- format ----------
const nf = new Intl.NumberFormat('ru-RU');
function usd(v) {
  if (v == null || !Number.isFinite(+v)) return '—';
  v = +v;
  const a = Math.abs(v);
  const s = a >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : v.toFixed(0);
  return (v < 0 ? '−$' : '$') + s.replace('-', '');
}
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' мин';
  if (s < 86400) return Math.round(s / 3600) + ' ч';
  return Math.round(s / 86400) + ' д';
}
function hhmm(ts) {
  return new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
// FNV-1a → [0,1); stable star positions per address.
function hash(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
const REASONS = {
  'tag:wash_trader': 'wash-трейдинг', 'tag:arbitrager': 'арбитраж', 'tag:dex_bot': 'DEX-бот', 'tag:bundler': 'бандлер',
  'tag:rat_trader': 'инсайдер', 'tag:sandwich_bot': 'сэндвич-бот', 'tag:sniper': 'снайпер',
  trades_per_day: '> 300 сделок в сутки', median_hold: 'удержание < 60 с', kol_dumper: 'KOL-дампер',
};
const reason = (r) => REASONS[r] || r || '';

// ---------- data ----------
async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' ' + res.status);
  return res.json();
}
const state = { summary: null, sky: null, signals: null, wallets: null, tab: null };

async function load() {
  const [summary, sky, signals, wallets] = await Promise.allSettled([
    get('/api/public/summary'), get('/api/public/sky'), get('/api/public/signals'), get('/api/public/wallets'),
  ]);
  if (summary.status === 'fulfilled') state.summary = summary.value;
  if (sky.status === 'fulfilled') { state.sky = sky.value; Sky.setData(sky.value); }
  if (signals.status === 'fulfilled') state.signals = signals.value;
  if (wallets.status === 'fulfilled') state.wallets = wallets.value;
  renderHud();
  renderSignals();
  renderWallets();
}

function renderHud() {
  const sky = state.sky, sum = state.summary;
  if (sum) $$('[data-delay]').forEach((el) => (el.textContent = sum.delay_min));
  if (sky) {
    const noise = sky.stars.filter((s) => s.excluded).length;
    setNum('stars', sky.stars.length);
    $('[data-k="noise"]').textContent = sky.stars.length ? Math.round((noise / sky.stars.length) * 100) + '%' : '—';
    setNum('asterisms', sky.asterisms.length);
  }
  if (sum?.watching_since) $('[data-since]').textContent = 'Наблюдаем с ' + hhmm(sum.watching_since) + ' МСК · ' + nf.format(sum.wallets) + ' кошельков в базе';
}
function setNum(key, value) {
  const el = $(`[data-k="${key}"]`);
  const from = +(el.dataset.v || 0);
  el.dataset.v = value;
  if (reduced || from === value) { el.textContent = nf.format(value); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = ease((t - t0) / 900);
    el.textContent = nf.format(Math.round(from + (value - from) * k));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- signals ----------
function renderSignals() {
  const body = $('[data-table="signals"] tbody');
  const empty = $('[data-empty="signals"]');
  const list = state.signals?.signals || [];
  if (list.length) {
    empty.hidden = true;
    body.innerHTML = list.map((s) => {
      const ws = JSON.parse(s.wallets_json || '[]');
      const max = s.max_24h && s.price_at_signal ? s.max_24h / s.price_at_signal : null;
      const now = s.price_24h && s.price_at_signal ? s.price_24h / s.price_at_signal : null;
      return `<tr><td class="muted">${hhmm(s.created_at)}</td><td>${tok(s.symbol, s.logo, s.token)}</td>
        <td>${tiers(ws.map((w) => w.tier))}</td><td class="r muted">—</td><td class="r">${usd(s.mc_at_signal)}</td>
        <td class="r ${max >= 2 ? 'up' : ''}">${max ? '×' + max.toFixed(1) : '<span class="muted">идёт</span>'}</td>
        <td class="r ${now == null ? '' : now >= 1 ? 'up' : 'down'}">${now ? '×' + now.toFixed(2) : '—'}</td></tr>`;
    }).join('');
    return;
  }
  // No scored signals yet: show raw convergences, clearly labelled.
  const raw = state.sky?.asterisms || [];
  empty.hidden = false;
  empty.innerHTML = raw.length
    ? '<b>Сигналов пока нет — ранги ещё считаются.</b>Ниже сырые совпадения: 3+ кошелька без пометки «бот» купили один токен за 30 минут. Это не сигналы.'
    : '<b>Сигналов пока нет.</b>Первые астеризмы появятся после первого пересчёта рангов кошельков.';
  body.innerHTML = raw.map((a) => `<tr><td class="muted">${hhmm(a.end)}</td><td>${tok(a.symbol, a.logo, a.token)}</td>
    <td>${tiers(a.wallets.map(() => null))} <span class="muted">${a.wallets.length}</span></td><td class="r">${usd(a.usd)}</td>
    <td class="r muted">—</td><td class="r muted">сырое</td><td class="r muted">—</td></tr>`).join('');
}
function tok(symbol, logo, address) {
  const img = logo ? `<img src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<img alt="">';
  return `<a class="tok" href="https://gmgn.ai/sol/token/${esc(address)}" target="_blank" rel="noopener">${img}$${esc(symbol || short(address))}</a>`;
}
function tiers(list) {
  return `<span class="tiers">${list.slice(0, 6).map((t) => `<i class="${t === 'A' ? '' : t === 'B' ? 'b' : 'n'}">${t || '·'}</i>`).join('')}</span>`;
}

// ---------- wallets ----------
function walletGroups() {
  const all = state.wallets?.wallets || [];
  return {
    A: all.filter((w) => !w.excluded_reason && w.tier === 'A'),
    B: all.filter((w) => !w.excluded_reason && w.tier === 'B'),
    C: all.filter((w) => !w.excluded_reason && w.tier === 'C'),
    kol: all.filter((w) => !w.excluded_reason && w.is_kol),
    x: all.filter((w) => w.excluded_reason),
  };
}
function renderWallets() {
  const groups = walletGroups();
  $$('.tabs button').forEach((b) => {
    b.dataset.label ||= b.textContent;
    b.innerHTML = `${b.dataset.label}<span class="c">${groups[b.dataset.tab].length}</span>`;
  });
  if (!state.tab) state.tab = ['A', 'B', 'C', 'kol', 'x'].find((t) => groups[t].length) || 'A';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  const list = groups[state.tab].slice(0, 100);
  const body = $('[data-table="wallets"] tbody');
  const empty = $('[data-empty="wallets"]');
  $('[data-col="metric"]').textContent = state.tab === 'x' ? 'Причина' : 'Hit ×2 / 24 ч';
  body.innerHTML = list.map((w, i) => `<tr>
    <td class="muted">${i + 1}</td>
    <td><span class="addr" data-copy="${esc(w.address)}" title="Скопировать">${esc(w.address)}</span></td>
    <td>${w.twitter_username ? `<a href="https://x.com/${esc(w.twitter_username)}" target="_blank" rel="noopener">@${esc(w.twitter_username)}</a>` : '<span class="muted">—</span>'}</td>
    <td class="r">${state.tab === 'x' ? `<span class="tag">${esc(reason(w.excluded_reason))}</span>` : pct(w.hit_rate_2x_24h)}</td>
    <td class="r ${w.pnl_30d > 0 ? 'up' : w.pnl_30d < 0 ? 'down' : ''}">${usd(w.pnl_30d)}</td>
    <td class="r">${pct(w.winrate_30d)}</td>
    <td class="r muted">${ago(w.last_seen)}</td></tr>`).join('');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = state.summary?.scored
      ? '<b>В этой группе пусто.</b>'
      : '<b>Ранги ещё не посчитаны.</b>Первый пересчёт — после суток наблюдения: нужны исходы покупок за 24 часа.';
  }
}
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tabs button');
  if (tab) { state.tab = tab.dataset.tab; renderWallets(); return; }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
      copy.classList.add('copied');
      setTimeout(() => copy.classList.remove('copied'), 900);
    }).catch(() => {});
  }
});

// ---------- live sky ----------
const Sky = (() => {
  const section = $('.sky');
  const canvas = $('.sky-canvas');
  const ctx = canvas.getContext('2d');
  const tip = $('.sky-tip');
  let w = 0, h = 0, stars = [], groups = [], visible = true, born = 0, mouse = { x: -1, y: -1, px: 0, py: 0 };
  // Pre-rendered glow sprite.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 64;
  const g = glow.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(238,241,248,.9)'); grad.addColorStop(.18, 'rgba(238,241,248,.35)'); grad.addColorStop(1, 'rgba(238,241,248,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);

  function resize() {
    const r = section.getBoundingClientRect();
    w = r.width; h = r.height;
    canvas.width = Math.round(w * DPR()); canvas.height = Math.round(h * DPR());
    ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0);
    layout();
  }

  function layout() {
    if (!state.sky) return;
    const mobile = w < 900;
    // Asterism anchors live in the upper-right, away from the headline.
    // Fixed slots keep asterisms apart and clear of the headline and HUD.
    const slots = mobile
      ? [[.3, .15], [.72, .25]]
      : [[.6, .26], [.84, .22], [.5, .5], [.73, .5], [.4, .2], [.93, .42]];
    groups = state.sky.asterisms.slice(0, slots.length).map((a, i) => {
      const [sx, sy] = slots[i];
      const cx = w * (sx + (hash(a.token, 7) - .5) * .04);
      const cy = Math.max(mobile ? 130 : 150, h * (sy + (hash(a.token, 9) - .5) * .04));
      return { ...a, cx, cy, r: (mobile ? 30 : 70) + a.wallets.length * (mobile ? 3 : 6), members: [] };
    });
    const member = new Map();
    groups.forEach((gr) => gr.wallets.forEach((addr) => { if (!member.has(addr)) member.set(addr, gr); }));
    stars = state.sky.stars.map((s) => {
      const gr = member.get(s.a);
      let x, y;
      if (gr) {
        const ang = hash(s.a, 3) * Math.PI * 2;
        const rad = gr.r * (.45 + .55 * hash(s.a, 5));
        x = gr.cx + Math.cos(ang) * rad; y = gr.cy + Math.sin(ang) * rad * .8;
      } else {
        x = hash(s.a, 1) * w; y = hash(s.a, 2) * h;
      }
      const tier = s.excluded ? 'x' : s.tier || 'c';
      const k = mobile ? 1 : 1.35;
      const base = { A: 2.6, B: 2.1, c: 1.5, C: 1.5, x: .95 }[tier] * k;
      const size = base + (tier === 'x' ? 0 : Math.min(1.4, Math.log10((s.vol || 0) + 10) * .28));
      const star = { ...s, x, y, tier, size, depth: .3 + hash(s.a, 4) * .7, phase: hash(s.a, 6) * 6.28, speed: .6 + hash(s.a, 8) * 1.6, gr };
      if (gr) gr.members.push(star);
      return star;
    });
    // Order members by angle so the asterism line reads as a shape, not a scribble.
    groups.forEach((gr) => gr.members.sort((p, q) => Math.atan2(p.y - gr.cy, p.x - gr.cx) - Math.atan2(q.y - gr.cy, q.x - gr.cx)));
  }

  function setData() {
    layout();
    born = performance.now();
  }

  function pos(s) {
    // Mouse parallax, deeper stars move less.
    return [s.x + mouse.px * s.depth * 14, s.y + mouse.py * s.depth * 10];
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    mouse.px += ((mouse.x < 0 ? 0 : mouse.x / w - .5) - mouse.px) * .04;
    mouse.py += ((mouse.y < 0 ? 0 : mouse.y / h - .5) - mouse.py) * .04;
    const intro = reduced ? 1 : ease((t - born) / 1400);
    for (const s of stars) {
      const [x, y] = pos(s);
      const tw = reduced ? 1 : .72 + .28 * Math.sin(t * .001 * s.speed + s.phase);
      const a = (s.tier === 'x' ? .26 : s.tier === 'A' ? 1 : s.tier === 'B' ? .9 : .74) * tw * intro;
      if (s.tier !== 'x') {
        const gs = s.size * (s.tier === 'A' ? 9 : s.tier === 'B' || s.gr ? 7 : 4.5);
        ctx.globalAlpha = a * (s.tier === 'A' || s.gr ? .6 : .32);
        ctx.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = s.gr ? '#ffe6bf' : '#eef1f8';
      ctx.beginPath(); ctx.arc(x, y, s.size, 0, 6.283); ctx.fill();
      if (s.kol && s.tier !== 'x') {
        ctx.globalAlpha = a * .8; ctx.strokeStyle = '#f4b860'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, s.size + 3, 0, 6.283); ctx.stroke();
      }
    }
    // Asterisms: lines draw in after the stars, then the label.
    const lp = reduced ? 1 : ease((t - born - 700) / 1600);
    groups.forEach((gr, gi) => {
      const pts = gr.members.map(pos);
      if (pts.length < 2) return;
      const k = clamp(lp * 1.4 - gi * .12);
      ctx.globalAlpha = .9 * k; ctx.strokeStyle = '#f4b860'; ctx.lineWidth = 1.25;
      ctx.beginPath();
      const segs = pts.length - 1;
      const upto = k * segs;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i <= segs; i++) {
        const f = clamp(upto - (i - 1));
        if (f <= 0) break;
        ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f);
      }
      ctx.stroke();
      if (k >= 1) {
        const top = pts.reduce((m, p) => (p[1] < m[1] ? p : m), pts[0]);
        ctx.globalAlpha = .95; ctx.fillStyle = '#f4b860'; ctx.font = '500 12px "JetBrains Mono", monospace';
        const mins = Math.max(1, Math.round((gr.end - gr.start) / 60));
        const text = `$${gr.symbol || short(gr.token)} · ${gr.wallets.length} за ${mins} мин`;
        const tw = ctx.measureText(text).width;
        const lx = Math.max(12, Math.min(w - tw - 12, top[0] + 10));
        ctx.fillText(text, lx, Math.max(16, top[1] - 12));
      }
    });
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    if (visible) draw(t);
    requestAnimationFrame(loop);
  }

  function hover(e) {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    let best = null, bd = 144;
    for (const s of stars) {
      const [x, y] = pos(s);
      const d = (x - mouse.x) ** 2 + (y - mouse.y) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) { tip.hidden = true; return; }
    const [x, y] = pos(best);
    tip.hidden = false;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    const label = best.excluded ? `<span class="t">шум · ${esc(reason(best.excluded))}</span>` : best.tier === 'c' ? 'без ранга' : 'ранг ' + best.tier;
    tip.innerHTML = `<b>${short(best.a)}</b>${best.x ? ' · @' + esc(best.x) : ''}${best.kol ? ' · KOL' : ''}<br>${label}<br>${best.n} сделок · ${usd(best.vol)} · ${ago(best.last)} назад`;
  }

  new ResizeObserver(resize).observe(section);
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(section);
  section.addEventListener('pointermove', hover);
  section.addEventListener('pointerleave', () => { tip.hidden = true; mouse.x = mouse.y = -1; });
  requestAnimationFrame(loop);
  return { setData };
})();

// ---------- story: noise → asterism ----------
(() => {
  const story = $('.story');
  const canvas = $('.story-canvas');
  const ctx = canvas.getContext('2d');
  const steps = $$('.step');
  const labels = $$('.sl');
  const alert = $('.alert');
  let w = 0, h = 0, s = 0, target = 0, visible = false;

  // Seeded dots: 72 bots, 3 A, 7 B, 18 C — the proportions we see in the feed.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const dots = Array.from({ length: 100 }, (_, i) => ({
    kind: i < 72 ? 'bot' : i < 75 ? 'A' : i < 82 ? 'B' : 'C',
    sx: rnd(), sy: rnd(), ph: rnd() * 6.28, sp: .5 + rnd() * 1.5, fall: .5 + rnd(),
    ox: 0, oy: 0,
  }));
  // Ranked positions as offsets from the token node: A stars close, B/C on outer rings.
  dots.filter((d) => d.kind !== 'bot').forEach((d, i) => {
    const ring = d.kind === 'A' ? .17 : d.kind === 'B' ? .3 : .4;
    const ang = d.kind === 'A' ? -Math.PI / 2 + (i * 2 * Math.PI) / 3 + .3 : rnd() * 6.28;
    d.ox = Math.cos(ang) * ring * .78;
    d.oy = Math.sin(ang) * ring;
  });
  // On phones the alert card covers the lower half of the stage.
  const nodeAt = () => (innerWidth < 900 ? { x: .5, y: .3, k: .62 } : { x: .42, y: .42, k: 1 });

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = r.width; h = r.height;
    canvas.width = Math.round(w * DPR()); canvas.height = Math.round(h * DPR());
    ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0);
  }

  function progress() {
    // s ∈ [0, 3]: 0 at step 1 centred, 3 at step 4 centred.
    const vh = innerHeight;
    const first = steps[0].getBoundingClientRect();
    const span = steps[1].getBoundingClientRect().top - first.top;
    const focus = innerWidth < 900 ? .72 : .5;
    const c = vh * focus - (first.top + first.height / 2);
    return clamp(c / span, 0, 3);
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    const k1 = ease(s - .35);          // bots go
    const k2 = ease((s - 1.3) / .9);   // survivors rank
    const k3 = ease((s - 2.2) / .8);   // asterism
    const pad = 28;
    const node = nodeAt();
    const nx = pad + node.x * (w - pad * 2), ny = pad + node.y * (h - pad * 2);
    const placeA = [];
    for (const d of dots) {
      const jx = reduced ? 0 : Math.sin(t * .0012 * d.sp + d.ph) * 6 * (1 - k2);
      const jy = reduced ? 0 : Math.cos(t * .0010 * d.sp + d.ph) * 6 * (1 - k2);
      let x = pad + d.sx * (w - pad * 2) + jx, y = pad + d.sy * (h - pad * 2) + jy;
      let a = .55, r = 1.6, color = '238,241,248';
      if (d.kind === 'bot') {
        const red = clamp(k1 * 2);
        color = red > .5 ? '240,138,122' : '238,241,248';
        a = .55 * (1 - clamp((k1 - .35) / .65));
        y += clamp((k1 - .35) / .65) * 70 * d.fall;
        if (a <= 0.01) continue;
      } else {
        const tx = pad + (node.x + d.ox * node.k) * (w - pad * 2), ty = pad + (node.y + d.oy * node.k) * (h - pad * 2);
        x += (tx - x) * k2; y += (ty - y) * k2;
        const big = d.kind === 'A' ? 3.4 : d.kind === 'B' ? 2.5 : 1.7;
        r = 1.6 + (big - 1.6) * k2;
        a = .55 + (d.kind === 'C' ? 0 : .45) * k2;
        if (d.kind === 'A') placeA.push([x, y]);
        if (k2 > .05 && d.kind !== 'C') {
          ctx.globalAlpha = a * .35 * k2; ctx.fillStyle = `rgba(${color},1)`;
          ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, 6.283); ctx.fill();
        }
      }
      ctx.globalAlpha = a; ctx.fillStyle = `rgb(${color})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      if (d.kind === 'A' && k2 > .6 && k3 < .5) {
        ctx.globalAlpha = (k2 - .6) / .4 * (1 - k3 * 2); ctx.fillStyle = '#eef1f8'; ctx.font = '500 10px "JetBrains Mono", monospace';
        ctx.fillText('A', x + 7, y - 7);
      }
    }
    // Asterism: A stars connect to each other and to the token node.
    if (k3 > 0 && placeA.length === 3) {
      ctx.globalAlpha = 1; ctx.strokeStyle = '#f4b860'; ctx.lineWidth = 1.2;
      const order = [placeA[0], placeA[1], placeA[2], placeA[0]];
      ctx.beginPath(); ctx.moveTo(order[0][0], order[0][1]);
      const segs = 3, upto = k3 * segs;
      for (let i = 1; i <= segs; i++) {
        const f = clamp(upto - (i - 1));
        if (f <= 0) break;
        ctx.lineTo(order[i - 1][0] + (order[i][0] - order[i - 1][0]) * f, order[i - 1][1] + (order[i][1] - order[i - 1][1]) * f);
      }
      ctx.stroke();
      ctx.globalAlpha = k3 * .45; ctx.setLineDash([3, 5]);
      ctx.beginPath(); placeA.forEach(([x, y]) => { ctx.moveTo(x, y); ctx.lineTo(nx, ny); }); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = k3; ctx.fillStyle = '#f4b860';
      ctx.beginPath(); ctx.arc(nx, ny, 4 + 2 * Math.sin(t * .004), 0, 6.283); ctx.fill();
      ctx.font = '600 12px "JetBrains Mono", monospace'; ctx.fillText('$SYMBOL', nx + 12, ny + 4);
    }
    ctx.globalAlpha = 1;
    labels.forEach((l, i) => l.classList.toggle('on', i === 0 ? s < .6 : i === 1 ? s >= .6 && s < 1.5 : s >= 1.5 && s < 2.4));
    const ka = clamp((s - 2.55) / .4);
    alert.style.opacity = ka;
    alert.style.setProperty('--k', ka);
    steps.forEach((el, i) => el.classList.toggle('on', Math.abs(s - i) < .5));
  }

  function loop(t) {
    if (visible) {
      target = progress();
      s += reduced ? target - s : (target - s) * .12;
      draw(t);
    }
    requestAnimationFrame(loop);
  }
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: '200px' }).observe(story);
  requestAnimationFrame(loop);
})();

// ---------- chrome: header, progress, reveals ----------
(() => {
  const top = $('.top');
  const bar = document.createElement('div');
  bar.className = 'progress';
  document.body.append(bar);
  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      top.classList.toggle('scrolled', scrollY > 40);
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      ticking = false;
    });
  }, { passive: true });

  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: .15 });
  $$('[data-reveal], [data-pop]').forEach((el) => io.observe(el));
  // Headline lines rise in sequence.
  const h1 = $('.h1');
  $$('.line > span', h1).forEach((el, i) => (el.style.transitionDelay = 80 + i * 110 + 'ms'));
  requestAnimationFrame(() => h1.classList.add('in'));
})();

load().catch((e) => console.error(e));
setInterval(() => load().catch(() => {}), 60_000);
