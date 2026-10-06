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
const nf = new Intl.NumberFormat('en-US');
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
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
function hhmm(ts) {
  return new Date(ts * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
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
  'tag:wash_trader': 'wash trader', 'tag:arbitrager': 'arbitrage', 'tag:dex_bot': 'DEX bot', 'tag:bundler': 'bundler',
  'tag:rat_trader': 'insider', 'tag:sandwich_bot': 'sandwich bot', 'tag:sniper': 'sniper',
  trades_per_day: '> 300 trades a day', median_hold: 'holds < 60 s', kol_dumper: 'KOL dumper',
};
const reason = (r) => REASONS[r] || r || '';

// ---------- data ----------
// Snapshot mode (static hosting): the build stamps <html data-snapshot="cutoff">
// and ships /api/public/*.json files instead of a live backend.
const SNAPSHOT = Number(document.documentElement.dataset.snapshot) || 0;
function apiPath(path) {
  if (!SNAPSHOT) return path;
  const [route, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if (route === '/api/public/wallet') return `/api/public/wallet/${encodeURIComponent(params.get('a') || '')}.json`;
  return route + '.json';
}
async function get(path) {
  const res = await fetch(apiPath(path), { cache: SNAPSHOT ? 'default' : 'no-store' });
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
  }
  if (sum?.bot) {
    $$('[data-bot]').forEach((a) => { a.href = `https://t.me/${sum.bot}`; a.target = '_blank'; a.rel = 'noopener'; });
    const note = $('[data-bot-note]');
    if (note) note.textContent = '@' + sum.bot;
    const handle = $('[data-bot-handle]');
    if (handle) { handle.textContent = '@' + sum.bot; handle.closest('[data-copy]').dataset.copy = '@' + sum.bot; }
  }
  if (sum?.watching_since) $('[data-since]').textContent = 'Watching since ' + hhmm(sum.watching_since) + ' · ' + nf.format(sum.wallets) + ' wallets tracked';
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
        <td class="r ${max >= 2 ? 'up' : ''}">${max ? max.toFixed(1) + '×' : '<span class="muted">tracking</span>'}</td>
        <td class="r ${now == null ? '' : now >= 1 ? 'up' : 'down'}">${now ? now.toFixed(2) + '×' : '—'}</td></tr>`;
    }).join('');
    return;
  }
  // No scored signals yet: show raw convergences, clearly labelled.
  const raw = state.sky?.asterisms || [];
  empty.hidden = false;
  empty.innerHTML = raw.length
    ? '<b>No signals yet — ranks are still being computed.</b>Below are raw matches: 3+ wallets not flagged as bots bought one token within 30 minutes. These are not signals.'
    : '<b>No signals yet.</b>The first asterisms appear after the first wallet scoring run.';
  body.innerHTML = raw.map((a) => `<tr><td class="muted">${hhmm(a.end)}</td><td>${tok(a.symbol, a.logo, a.token)}</td>
    <td>${tiers(a.wallets.map(() => null))} <span class="muted">${a.wallets.length}</span></td><td class="r">${usd(a.usd)}</td>
    <td class="r muted">—</td><td class="r muted">raw</td><td class="r muted">—</td></tr>`).join('');
}
function tok(symbol, logo, address) {
  const img = logo ? `<img src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : '<img alt="">';
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
    d: all.filter((w) => w.discovered_at).sort((a, b) => b.early_hits - a.early_hits),
    x: all.filter((w) => w.excluded_reason),
  };
}
function renderWallets() {
  const groups = walletGroups();
  $$('.tabs button').forEach((b) => {
    b.dataset.label ||= b.textContent;
    b.innerHTML = `${b.dataset.label}<span class="c">${groups[b.dataset.tab].length}</span>`;
  });
  if (!state.tab) state.tab = ['A', 'B', 'C', 'd', 'kol', 'x'].find((t) => groups[t].length) || 'A';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  const list = groups[state.tab].slice(0, 100);
  const body = $('[data-table="wallets"] tbody');
  const empty = $('[data-empty="wallets"]');
  $('[data-col="metric"]').textContent = state.tab === 'x' ? 'Reason' : state.tab === 'd' ? 'Early in' : 'Hit 2× / 24h';
  body.innerHTML = list.map((w, i) => `<tr data-wallet="${esc(w.address)}">
    <td class="muted">${i + 1}</td>
    <td><span class="addr" data-copy="${esc(w.address)}" title="Copy">${esc(w.address)}</span>${w.discovered_at ? `<span class="src d">early ×${w.early_hits}</span>` : ''}</td>
    <td>${w.twitter_username ? `<a href="https://x.com/${esc(w.twitter_username)}" target="_blank" rel="noopener">@${esc(w.twitter_username)}</a>` : '<span class="muted">—</span>'}</td>
    <td class="r">${state.tab === 'x' ? `<span class="tag">${esc(reason(w.excluded_reason))}</span>` : state.tab === 'd' ? `${w.early_hits} winners` : pct(w.hit_rate_2x_24h)}</td>
    <td class="r ${w.pnl_30d > 0 ? 'up' : w.pnl_30d < 0 ? 'down' : ''}">${usd(w.pnl_30d)}</td>
    <td class="r">${pct(w.winrate_30d)}</td>
    <td class="r muted">${ago(w.last_seen)}</td></tr>`).join('');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = state.summary?.scored
      ? '<b>Nothing in this group yet.</b>'
      : '<b>Ranks are not computed yet.</b>The first scoring run needs a full day of data: every buy has to show its 24-hour outcome.';
  }
}
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tabs button');
  if (tab) { state.tab = tab.dataset.tab; renderWallets(); return; }
  const copy = e.target.closest('[data-copy]');
  if (!copy) {
    const walletEl = e.target.closest('[data-wallet]');
    if (walletEl && !e.target.closest('a')) { Drawer.open(walletEl.dataset.wallet); return; }
  }
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
  const byAddr = new Map();
  const extra = new Map(); // wallets first seen on the live tape, kept across relayouts
  const flares = [];
  // Pre-rendered glow sprite.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 64;
  const g = glow.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(242,244,243,.9)'); grad.addColorStop(.18, 'rgba(242,244,243,.35)'); grad.addColorStop(1, 'rgba(242,244,243,0)');
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
      ? [[.3, .2], [.7, .85]]
      : [[.13, .22], [.87, .2], [.12, .7], [.88, .68], [.3, .1], [.7, .1]];
    // Desktop: around the centred copy. Phones: in the band between header and copy.
    const copyTop = mobile ? $('.sky-copy').offsetTop : 0;
    groups = state.sky.asterisms.slice(0, slots.length).map((a, i) => {
      const [sx, sy] = slots[i];
      const cx = w * (sx + (hash(a.token, 7) - .5) * .04);
      const cy = mobile
        ? 96 + Math.max(40, copyTop - 150) * sy
        : Math.max(150, h * (sy + (hash(a.token, 9) - .5) * .04));
      return { ...a, cx, cy, r: (mobile ? 30 : 70) + a.wallets.length * (mobile ? 3 : 6), members: [] };
    });
    const member = new Map();
    groups.forEach((gr) => gr.wallets.forEach((addr) => { if (!member.has(addr)) member.set(addr, gr); }));
    const known = new Set(state.sky.stars.map((s) => s.a));
    const live = [...extra.values()].filter((s) => !known.has(s.a));
    stars = [...state.sky.stars, ...live].map((s) => {
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
      const star = { ...s, x, y, tier, size, depth: .3 + hash(s.a, 4) * .7, phase: hash(s.a, 6) * 6.28, speed: .6 + hash(s.a, 8) * 1.6, gr, hot: 0, born: s.born || 0 };
      if (gr) gr.members.push(star);
      return star;
    });
    byAddr.clear();
    stars.forEach((star) => byAddr.set(star.a, star));
    // Order members by angle so the asterism line reads as a shape, not a scribble.
    groups.forEach((gr) => gr.members.sort((p, q) => Math.atan2(p.y - gr.cy, p.x - gr.cx) - Math.atan2(q.y - gr.cy, q.x - gr.cx)));
  }

  function setData() {
    const first = !stars.length;
    layout();
    if (first) born = performance.now();
  }

  /** A trade from the tape: the wallet's star flares; unknown wallets appear. */
  function flare(trade) {
    const now = performance.now();
    let star = byAddr.get(trade.w);
    if (!star) {
      const fresh = { a: trade.w, tier: trade.tier, score: null, kol: trade.kol, x: trade.x, n: 1, vol: trade.usd, last: trade.ts, excluded: trade.noise, born: now };
      extra.set(trade.w, fresh);
      if (extra.size > 600) extra.delete(extra.keys().next().value);
      layout();
      star = byAddr.get(trade.w);
      if (!star) return;
    }
    star.hot = now;
    star.n += 1;
    star.vol += trade.usd;
    star.last = trade.ts;
    flares.push({ star, t0: now, color: trade.noise ? '240,138,122' : trade.side === 'buy' ? '244,184,96' : '242,244,243', big: trade.usd >= 1000 });
    if (flares.length > 80) flares.shift();
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
      const heat = s.hot ? clamp(1 - (t - s.hot) / 1400) : 0;
      const fadeIn = s.born ? clamp((t - s.born) / 900) : 1;
      const a = Math.min(1, (s.tier === 'x' ? .26 : s.tier === 'A' ? 1 : s.tier === 'B' ? .9 : .74) * tw * intro + heat * .7) * fadeIn;
      if (s.tier !== 'x') {
        const gs = s.size * (s.tier === 'A' ? 9 : s.tier === 'B' || s.gr ? 7 : 4.5);
        ctx.globalAlpha = a * (s.tier === 'A' || s.gr ? .6 : .32);
        ctx.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = s.gr ? '#ffe6bf' : '#f2f4f3';
      ctx.beginPath(); ctx.arc(x, y, s.size * (1 + heat * .8), 0, 6.283); ctx.fill();
      if (s.kol && s.tier !== 'x' && (s.tier === 'A' || s.tier === 'B' || s.gr)) {
        ctx.globalAlpha = a * .45; ctx.strokeStyle = '#f4b860'; ctx.lineWidth = .8;
        ctx.beginPath(); ctx.arc(x, y, s.size + 3, 0, 6.283); ctx.stroke();
      }
    }
    // Flares: an expanding ring where a wallet just traded.
    for (let i = flares.length - 1; i >= 0; i--) {
      const f = flares[i];
      const k = (t - f.t0) / (f.big ? 1600 : 1100);
      if (k >= 1) { flares.splice(i, 1); continue; }
      const [x, y] = pos(f.star);
      ctx.globalAlpha = (1 - k) * .9;
      ctx.strokeStyle = `rgb(${f.color})`; ctx.lineWidth = f.big ? 1.5 : 1;
      ctx.beginPath(); ctx.arc(x, y, f.star.size + 3 + ease(k) * (f.big ? 34 : 18), 0, 6.283); ctx.stroke();
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
        const text = `$${gr.symbol || short(gr.token)} · ${gr.wallets.length} in ${mins} min`;
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
    const label = best.excluded ? `<span class="t">noise · ${esc(reason(best.excluded))}</span>` : best.tier === 'c' ? 'unranked' : 'rank ' + best.tier;
    tip.innerHTML = `<b>${short(best.a)}</b>${best.x ? ' · @' + esc(best.x) : ''}${best.kol ? ' · KOL' : ''}<br>${label}<br>${best.n} trades · ${usd(best.vol)} · ${ago(best.last)}<br><span class="t">click for transactions</span>`;
  }

  new ResizeObserver(resize).observe(section);
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(section);
  section.addEventListener('pointermove', hover);
  section.addEventListener('pointerleave', () => { tip.hidden = true; mouse.x = mouse.y = -1; });
  canvas.style.cursor = 'crosshair';
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 196;
    for (const s of stars) {
      const [x, y] = pos(s);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    if (best) Drawer.open(best.a);
  });
  requestAnimationFrame(loop);
  return { setData, flare };
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
      let a = .55, r = 1.6, color = '242,244,243';
      if (d.kind === 'bot') {
        const red = clamp(k1 * 2);
        color = red > .5 ? '240,138,122' : '242,244,243';
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
        ctx.globalAlpha = (k2 - .6) / .4 * (1 - k3 * 2); ctx.fillStyle = '#f2f4f3'; ctx.font = '500 10px "JetBrains Mono", monospace';
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

// ---------- wallet drawer: profile + real transactions ----------
const Drawer = (() => {
  const root = $('.drawer');
  const body = $('.drawer-body', root);
  let current = null;
  const SOURCE = { gmgn_sm: 'GMGN smart money', gmgn_kol: 'GMGN KOL feed', discovery: 'Discovered', manual: 'Manual' };
  const TXSRC = { gmgn_sm: 'feed', gmgn_kol: 'kol', gmgn_activity: 'history' };

  function close() {
    if (location.hash.startsWith('#w=')) history.replaceState(null, '', location.pathname + location.search);
    root.hidden = true;
    current = null;
    window.__lenis?.start();
    document.documentElement.style.overflow = '';
  }

  async function open(address) {
    if (!address) return;
    current = address;
    root.hidden = false;
    window.__lenis?.stop();
    document.documentElement.style.overflow = 'hidden';
    body.innerHTML = `<p class="d-kicker">Wallet</p><p class="d-addr">${esc(address)}</p><p class="d-empty">Loading transactions…</p>`;
    let data;
    try { data = await get('/api/public/wallet?a=' + encodeURIComponent(address)); } catch { data = { error: 'load failed' }; }
    if (current !== address) return;
    if (data.error) { body.innerHTML += `<p class="d-empty">${esc(data.error)}</p>`; return; }
    render(data);
  }

  function render({ wallet: w, totals, early, trades, delay_min }) {
    const tier = w.excluded_reason ? 'X' : w.tier || '·';
    const status = w.excluded_reason ? `<span class="tag">dimmed · ${esc(reason(w.excluded_reason))}</span>` : w.tier ? 'rank ' + w.tier : 'unranked';
    const src = w.discovered_at ? 'Discovered' + (w.source !== 'discovery' ? ' · ' + (SOURCE[w.source] || w.source) : '') : SOURCE[w.source] || w.source;
    const tok = (t) => `${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : '<img alt="">'}$${esc(t.symbol || short(t.token))}`;
    const earlyHtml = early.length ? `
      <h3 class="d-h">Profitable in winners <small>entry ÷ ATH market cap</small></h3>
      <ul class="d-list early">${early.map((e) => `<li>
        <span><span class="sym">${tok(e)}</span><span class="note">ATH ${usd(e.ath_mc)} · ${e.kind === 'tagged' ? 'GMGN-tagged, entered' : 'entered'} at ${(e.entry_ratio * 100).toFixed(1)}% of ATH · in ${usd(e.cost)}</span></span>
        <a class="r tx-link" href="https://gmgn.ai/sol/token/${esc(e.token)}?maker=${esc(w.address)}" target="_blank" rel="noopener">${usd(e.profit)}</a></li>`).join('')}</ul>` : '';
    const txHtml = trades.length ? `<ul class="d-list">${trades.map((t) => `<li>
        <span class="tm">${new Date(t.ts * 1000).toISOString().slice(5, 16).replace('T', ' ')}</span>
        <span class="side-${t.side}">${t.side === 'buy' ? 'BUY' : 'SELL'}</span>
        <span class="sym">${tok(t)}${t.full ? `<span class="flag">${t.side === 'buy' ? 'OPEN' : 'EXIT'}</span>` : ''}<span class="src">${TXSRC[t.source] || ''}</span></span>
        <a class="r tx-link" href="https://solscan.io/tx/${esc(t.tx)}" target="_blank" rel="noopener" title="View on Solscan">${usd(t.usd)}</a></li>`).join('')}</ul>`
      : '<p class="d-empty">No transactions older than the public delay yet.</p>';
    body.innerHTML = `
      <p class="d-kicker"><span class="pill ${tier}">${tier === 'X' ? '×' : tier}</span>${status} · ${esc(src)}${w.is_kol ? ' · KOL' : ''}</p>
      <p class="d-addr" data-copy="${esc(w.address)}" title="Copy address">${esc(w.address)}</p>
      ${w.twitter_username ? `<p class="d-kicker"><a href="https://x.com/${esc(w.twitter_username)}" target="_blank" rel="noopener">@${esc(w.twitter_username)}</a></p>` : ''}
      <div class="d-links">
        <a href="https://solscan.io/account/${esc(w.address)}" target="_blank" rel="noopener">Solscan ↗</a>
        <a href="https://gmgn.ai/sol/address/${esc(w.address)}" target="_blank" rel="noopener">GMGN ↗</a>
      </div>
      <div class="d-stats">
        <div><span>Trades</span><b>${nf.format(totals.n || 0)}</b></div>
        <div><span>Buys</span><b>${nf.format(totals.buys || 0)}</b></div>
        <div><span>Tokens</span><b>${nf.format(totals.tokens || 0)}</b></div>
        <div><span>Volume</span><b>${usd(totals.usd || 0)}</b></div>
      </div>
      ${earlyHtml}
      <h3 class="d-h">Transactions <small>latest ${trades.length} · ${delay_min} min delay</small></h3>
      ${txHtml}
      <p class="d-foot">Every row links to the on-chain transaction on Solscan. “feed” rows come from GMGN's live feeds, “history” rows from the wallet's own activity.</p>`;
  }

  root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });
  return { open, close };
})();

if (SNAPSHOT) {
  const at = new Date(SNAPSHOT * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const live = $('.live');
  if (live) live.innerHTML = '<i class="off"></i>Snapshot';
  const delay = $('.tape-delay');
  if (delay) delay.textContent = at;
  const kicker = $('.eyebrow span:last-child');
  if (kicker) kicker.innerHTML = `Solana smart money · snapshot ${at}`;
}

// ---------- live tape: replay the delayed feed at its real pace ----------
const Tape = (() => {
  const list = $('.tape-rows');
  const toggle = $('[data-tape-filter]');
  const ROWS = 12;
  let queue = [];
  let lag = null;          // seconds between wall clock and the replayed moment
  let lastTs = 0;
  let hideNoise = false;
  const emitted = [];      // timestamps (wall clock, s) for trades/min
  const seen = new Set();

  toggle.addEventListener('click', () => {
    hideNoise = !hideNoise;
    toggle.setAttribute('aria-pressed', String(hideNoise));
    toggle.textContent = hideNoise ? 'Show noise' : 'Hide noise';
    $$('li', list).forEach((li) => (li.hidden = hideNoise && li.classList.contains('noise')));
  });

  async function poll() {
    try {
      const data = await get('/api/public/feed?since=' + lastTs);
      const fresh = data.trades.filter((tr) => !seen.has(tr.tx + tr.w + tr.t + tr.side));
      fresh.forEach((tr) => seen.add(tr.tx + tr.w + tr.t + tr.side));
      if (seen.size > 5000) seen.clear();
      if (!fresh.length) {
        if (!list.children.length) list.innerHTML = `<li class="tape-empty">Waiting for trades older than ${data.delay_min} min…</li>`;
        return;
      }
      list.querySelector('.tape-empty')?.remove();
      lastTs = Math.max(lastTs, fresh.at(-1).ts);
      if (lag === null) {
        // Start 40 s behind the newest trade so there is a backlog to play.
        lag = Date.now() / 1000 - (lastTs - 40);
        const older = fresh.filter((tr) => tr.ts <= lastTs - 40).slice(-ROWS);
        older.forEach((tr) => row(tr, false));
        queue.push(...fresh.filter((tr) => tr.ts > lastTs - 40));
      } else {
        queue.push(...fresh);
      }
      // Never fall more than 90 s behind the newest published trade.
      const vt = Date.now() / 1000 - lag;
      if (lastTs - vt > 90) lag -= lastTs - vt - 60;
    } catch { /* keep the last tape */ }
  }

  function row(tr, animate = true) {
    const li = document.createElement('li');
    if (tr.noise) li.className = 'noise';
    if (!animate) li.style.animation = 'none';
    const tier = tr.noise ? 'X' : tr.tier || '·';
    const who = tr.x ? '@' + esc(tr.x) : short(tr.w);
    const flag = tr.full ? `<span class="flag">${tr.side === 'buy' ? 'OPEN' : 'EXIT'}</span>` : '';
    const time = new Date(tr.ts * 1000).toISOString().slice(11, 19);
    const img = tr.logo ? `<img src="${esc(tr.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : '<img alt="">';
    li.innerHTML = `<span class="tm">${time}</span><span class="pill ${tier}" title="${tr.noise ? esc(reason(tr.noise)) : 'rank ' + tier}">${tier === 'X' ? '×' : tier}</span>`
      + `<span class="who" data-wallet="${esc(tr.w)}" title="Open wallet">${who}</span><span class="side-${tr.side}">${tr.side === 'buy' ? 'BUY' : 'SELL'}</span>`
      + `<span class="sym">${img}$${esc(tr.s || short(tr.t))}${flag}</span>`
      + `<a class="usd" href="https://solscan.io/tx/${esc(tr.tx)}" target="_blank" rel="noopener" title="View transaction on Solscan">${usd(tr.usd)}</a>`;
    li.hidden = hideNoise && Boolean(tr.noise);
    list.prepend(li);
    while (list.children.length > ROWS * 2) list.lastChild.remove();
  }

  function tick() {
    if (lag === null) return;
    const vt = Date.now() / 1000 - lag;
    let n = 0;
    while (queue.length && queue[0].ts <= vt) {
      const tr = queue.shift();
      // Flood guard: flare every trade, but only render the last few of a burst.
      if (queue.length < 6 || n < 4) row(tr);
      Sky.flare(tr);
      emitted.push(Date.now() / 1000);
      n++;
    }
    const cut = Date.now() / 1000 - 60;
    while (emitted.length && emitted[0] < cut) emitted.shift();
  }

  function tpm() {
    return emitted.length;
  }

  poll();
  setInterval(poll, 6000);
  setInterval(tick, reduced ? 1000 : 120);
  setInterval(() => { if (lag !== null) setNum('tpm', tpm()); }, 2000);
  return {};
})();

// ---------- pulse: trades per 15 min, kept vs dimmed ----------
const Pulse = (() => {
  const canvas = $('.chart-canvas');
  const ctx = canvas.getContext('2d');
  const tip = $('.chart-tip');
  const wrap = $('.chart');
  let data = null, w = 0, h = 0, shown = 0, hover = -1, started = false;

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = r.width; h = r.height;
    canvas.width = Math.round(w * DPR()); canvas.height = Math.round(h * DPR());
    ctx.setTransform(DPR(), 0, 0, DPR(), 0, 0);
    draw();
  }

  function set(d) {
    data = d;
    $('[data-p="trades"]').textContent = nf.format(d.totals.trades);
    $('[data-p="wallets"]').textContent = nf.format(d.totals.wallets);
    $('[data-p="tokens"]').textContent = nf.format(d.totals.tokens);
    $('[data-p="usd"]').textContent = usd(d.buckets.reduce((sum, b) => sum + b.usd, 0));
    const first = d.buckets.find((b) => b.real + b.noise > 0);
    $('[data-chart-note]').textContent = first && first.t > d.buckets[0].t + 900
      ? 'collecting since ' + new Date(first.t * 1000).toISOString().slice(11, 16) + ' UTC'
      : 'last 24 hours · UTC';
    draw();
  }

  function draw() {
    if (!data || !w) return;
    ctx.clearRect(0, 0, w, h);
    const bs = data.buckets;
    const max = Math.max(10, ...bs.map((b) => b.real + b.noise));
    const padB = 22, padT = 8;
    const bw = w / bs.length;
    const k = reduced ? 1 : ease(shown);
    // grid
    ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(242,244,243,.06)'; ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const y = Math.round(padT + (h - padB - padT) * (1 - g / 3)) + .5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = 'rgba(242,244,243,.3)'; ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.fillText(nf.format(Math.round((max * g) / 3)), 4, y - 4);
    }
    bs.forEach((b, i) => {
      const x = i * bw + 1;
      const bwi = Math.max(1, bw - 2);
      const hr = ((h - padB - padT) * b.real / max) * k;
      const hn = ((h - padB - padT) * b.noise / max) * k;
      const base = h - padB;
      ctx.globalAlpha = hover === -1 || hover === i ? 1 : .45;
      ctx.fillStyle = 'rgba(240,138,122,.5)';
      ctx.fillRect(x, base - hr - hn, bwi, hn);
      ctx.fillStyle = '#f2f4f3';
      ctx.fillRect(x, base - hr, bwi, hr);
      if (i % 16 === 0) {
        ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(242,244,243,.38)'; ctx.font = '500 10px "JetBrains Mono", monospace';
        ctx.fillText(new Date(b.t * 1000).toISOString().slice(11, 16), x, h - 6);
      }
    });
    ctx.globalAlpha = 1;
  }

  function animate(t0) {
    const step = (t) => {
      shown = clamp((t - t0) / 1200);
      draw();
      if (shown < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!data) return;
    const r = canvas.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * data.buckets.length);
    const b = data.buckets[i];
    if (!b) return;
    hover = i; draw();
    const wr = wrap.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = e.clientX - wr.left + 'px';
    tip.style.top = e.clientY - wr.top + 'px';
    const total = b.real + b.noise;
    tip.innerHTML = `${new Date(b.t * 1000).toISOString().slice(11, 16)} UTC<br><b>${nf.format(b.real)}</b> kept · ${nf.format(b.noise)} dimmed${total ? ` (${Math.round((b.noise / total) * 100)}%)` : ''}<br>kept volume ${usd(b.usd)}`;
  });
  canvas.addEventListener('pointerleave', () => { hover = -1; tip.hidden = true; draw(); });
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !started) { started = true; animate(performance.now()); }
  }, { threshold: .3 }).observe(canvas);

  async function load() {
    try { set(await get('/api/public/pulse')); } catch { /* keep */ }
  }
  load();
  setInterval(load, 60_000);
  return {};
})();

// ---------- page-wide field: drifting stars, meteors, passing constellations ----------
(() => {
  const canvas = $('.field');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const hero = $('#sky');
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  let w = 0, h = 0, stars = [], meteors = [], figures = [], on = false, last = 0, nextMeteor = 0, nextFigure = 0;

  function resize() {
    w = innerWidth; h = innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(220, (w * h) / 7000));
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    stars = Array.from({ length: count }, () => {
      const depth = rnd();                       // 0 far … 1 near
      return { x: rnd() * w, y: rnd() * h * 3, depth, r: .4 + depth * 1.3, a: .18 + depth * .5, tw: rnd() * 6.28, sp: .4 + rnd() * 1.4, vx: (rnd() - .5) * .006 * (1 + depth) };
    });
  }

  function spawnMeteor(t) {
    const fromLeft = Math.random() < .5;
    meteors.push({ t0: t, x: fromLeft ? Math.random() * w * .5 : w * (.5 + Math.random() * .5), y: Math.random() * h * .5, dx: fromLeft ? 1 : -1, len: 90 + Math.random() * 120, dur: 900 + Math.random() * 600 });
  }

  // A faint ember figure joins 3–5 near stars, holds, then dissolves: the
  // sky keeps forming asterisms as you read.
  function spawnFigure(t, sy) {
    const visible = stars.filter((s) => s.depth > .45).map((s) => ({ s, y: ((s.y - sy * s.depth * .25) % (h * 3) + h * 3) % (h * 3) })).filter((p) => p.y < h);
    if (visible.length < 6) return;
    const seedStar = visible[Math.floor(Math.random() * visible.length)];
    const near = visible.map((p) => ({ p, d: Math.hypot(p.s.x - seedStar.s.x, p.y - seedStar.y) })).filter((q) => q.d < 260).sort((a, b) => a.d - b.d).slice(0, 3 + Math.floor(Math.random() * 3));
    if (near.length < 3) return;
    figures.push({ t0: t, stars: near.map((q) => q.p.s), dur: 5200 });
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (!on || document.hidden || t - last < 33) return;
    last = t;
    const sy = scrollY;
    ctx.clearRect(0, 0, w, h);
    const pos = (s) => [((s.x + t * s.vx) % w + w) % w, ((s.y - sy * s.depth * .25) % (h * 3) + h * 3) % (h * 3)];
    for (const s of stars) {
      const [x, y] = pos(s);
      if (y > h) continue;
      ctx.globalAlpha = s.a * (reduced ? 1 : .7 + .3 * Math.sin(t * .001 * s.sp + s.tw));
      ctx.fillStyle = '#f2f4f3';
      ctx.beginPath(); ctx.arc(x, y, s.r, 0, 6.283); ctx.fill();
    }
    if (!reduced) {
      if (t > nextFigure) { spawnFigure(t, sy); nextFigure = t + 4000 + Math.random() * 4000; }
      for (let i = figures.length - 1; i >= 0; i--) {
        const f = figures[i];
        const k = (t - f.t0) / f.dur;
        if (k >= 1) { figures.splice(i, 1); continue; }
        const draw = clamp(k / .35), fade = k < .7 ? 1 : 1 - (k - .7) / .3;
        const pts = f.stars.map(pos);
        ctx.globalAlpha = .45 * fade; ctx.strokeStyle = '#f4b860'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        const segs = pts.length - 1, upto = draw * segs;
        for (let j = 1; j <= segs; j++) {
          const q = clamp(upto - (j - 1));
          if (q <= 0) break;
          ctx.lineTo(pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * q, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * q);
        }
        ctx.stroke();
        ctx.globalAlpha = .8 * fade; ctx.fillStyle = '#ffe6bf';
        pts.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 6.283); ctx.fill(); });
      }
      if (t > nextMeteor) { spawnMeteor(t); nextMeteor = t + 5000 + Math.random() * 7000; }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        const k = (t - m.t0) / m.dur;
        if (k >= 1) { meteors.splice(i, 1); continue; }
        const hx = m.x + m.dx * k * 420, hy = m.y + k * 240;
        const tx = hx - m.dx * m.len * .87, ty = hy - m.len * .5;
        const grad = ctx.createLinearGradient(hx, hy, tx, ty);
        grad.addColorStop(0, 'rgba(255,240,220,.9)'); grad.addColorStop(1, 'rgba(255,240,220,0)');
        ctx.globalAlpha = Math.sin(k * Math.PI);
        ctx.strokeStyle = grad; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // The hero has its own sky; the field takes over once it scrolls away.
  const update = () => {
    const next = scrollY > hero.offsetHeight * .55;
    if (next === on) return;
    on = next;
    canvas.classList.toggle('on', on);
  };
  addEventListener('scroll', update, { passive: true });
  update();
  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();

// ---------- polish: loader, smooth scroll, active nav, spotlight ----------
(() => {
  // Short branded loader; added by JS so the page never depends on it.
  if (!reduced && !sessionStorageSafe('seen')) {
    const loader = document.createElement('div');
    loader.className = 'loader';
    loader.innerHTML = '<div class="loader-in"><svg viewBox="0 0 24 24"><path d="M12 1.5c.5 5.6 4.9 10 10.5 10.5-5.6.5-10 4.9-10.5 10.5C11.5 16.9 7.1 12.5 1.5 12 7.1 11.5 11.5 7.1 12 1.5Z"/></svg><b>000</b></div>';
    document.body.append(loader);
    const counter = $('b', loader);
    const t0 = performance.now();
    const done = () => { loader.classList.add('out'); setTimeout(() => loader.remove(), 900); };
    const step = (t) => {
      const k = clamp((t - t0) / 1000);
      counter.textContent = String(Math.round(ease(k) * 100)).padStart(3, '0');
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
    setTimeout(done, 1600); // hard stop
  }

  if (!reduced && window.Lenis) {
    const lenis = new window.Lenis({ lerp: .1, smoothWheel: true });
    window.__lenis = lenis;
    const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const target = $(a.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -70 });
    });
  }

  const links = $$('.nav a');
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  ['method', 'pulse', 'signals', 'wallets'].forEach((id) => io.observe(document.getElementById(id)));
  io.observe($('#sky'));

  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('.glow');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', e.clientX - r.left + 'px');
    el.style.setProperty('--my', e.clientY - r.top + 'px');
  }, { passive: true });
})();

function sessionStorageSafe(key) {
  try {
    const had = sessionStorage.getItem('asterism:' + key);
    sessionStorage.setItem('asterism:' + key, '1');
    return had;
  } catch { return null; }
}

load().catch((e) => console.error(e));
setInterval(() => load().catch(() => {}), 60_000);

// Deep link from Telegram alerts: /#w=<address> opens that wallet.
function openFromHash() {
  const match = location.hash.match(/^#w=([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (match) Drawer.open(match[1]);
}
addEventListener('hashchange', openFromHash);
openFromHash();
