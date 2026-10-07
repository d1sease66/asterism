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
  renderStats();
  renderSignals();
  renderWallets();
}

function setText(key, text) {
  $$(`[data-k="${key}"]`).forEach((el) => (el.textContent = text));
}

function renderStats() {
  const sky = state.sky, sum = state.summary;
  if (sum) {
    $$('[data-delay]').forEach((el) => (el.textContent = sum.delay_min));
    const t = sum.tiers || {};
    setNum('wallets', sum.wallets);
    setNum('ab', (t.A || 0) + (t.B || 0));
    setNum('trades24h', sum.trades_24h);
    setNum('signals7d', sum.signals_7d);
    setText('trades24h-2', nf.format(sum.trades_24h));
    setText('excluded', nf.format(sum.excluded));
    setText('signals7d-2', nf.format(sum.signals_7d));
    setText('tiers', sum.scored ? `A ${nf.format(t.A || 0)} · B ${nf.format(t.B || 0)} · C ${nf.format(t.C || 0)}` : 'first scoring pending');
    if (sum.watching_since) $('[data-since]').textContent = `Data from GMGN · watching since ${hhmm(sum.watching_since)} · ${nf.format(sum.wallets)} wallets.`;
  }
  if (sky) setText('stars-cap', `${nf.format(sky.stars.length)} wallets · 24h`);
  if (sum?.bot) {
    $$('[data-bot]').forEach((a) => { a.href = `https://t.me/${sum.bot}`; a.target = '_blank'; a.rel = 'noopener'; });
    const handle = $('[data-bot-handle]');
    if (handle) { handle.textContent = '@' + sum.bot; handle.dataset.copy = '@' + sum.bot; }
  }
}
function setNum(key, value) {
  const el = $(`[data-k="${key}"]`);
  if (!el || value == null) return;
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
const TYPE_LABEL = { cluster: 'Cluster', cluster_kol: 'Cluster + KOL', a_first_entry: 'A-wallet first entry', exit_cluster: 'Exit cluster' };
function renderSignals() {
  const list = $('[data-list="signals"]');
  const signals = state.signals?.signals || [];
  if (signals.length) {
    list.innerHTML = signals.slice(0, 30).map((s) => {
      const ws = JSON.parse(s.wallets_json || '[]');
      const max = s.max_24h && s.price_at_signal ? s.max_24h / s.price_at_signal : null;
      const res = max ? `<span class="${max >= 2 ? 'side-buy' : ''}">${max.toFixed(2)}×</span><small>24h max</small>` : '<span class="muted">tracking</span><small>result in 24h</small>';
      return `<li><div>${tok(s.symbol, s.logo, s.token, 'sym')}<div class="what">${TYPE_LABEL[s.type] || s.type} · ${ws.length} wallet${ws.length === 1 ? '' : 's'} · MC ${usd(s.mc_at_signal)} · ${hhmm(s.created_at)}</div></div><div class="res">${res}</div></li>`;
    }).join('');
    return;
  }
  // No signals yet: show raw convergences, clearly labelled.
  const raw = state.sky?.asterisms || [];
  list.innerHTML = `<li class="sig-empty"><b>No signals in the public window yet.</b>${raw.length ? 'Below: raw matches of 3+ non-bot wallets in one token within 30 minutes. Not signals.' : 'Signals appear here 15 minutes after the bot sends them.'}</li>`
    + raw.slice(0, 12).map((a) => `<li><div>${tok(a.symbol, a.logo, a.token, 'sym')}<div class="what">raw match · ${a.wallets.length} wallets · ${usd(a.usd)} · ${hhmm(a.end)}</div></div><div class="res"><span class="muted">raw</span></div></li>`).join('');
}
function tok(symbol, logo, address, cls = 'tok') {
  const img = logo ? `<img src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : '<img alt="">';
  return `<a class="${cls}" href="https://gmgn.ai/sol/token/${esc(address)}" target="_blank" rel="noopener">${img}$${esc(symbol || short(address))}</a>`;
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
  const section = $('.sky-card');
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
    const mobile = w < 560;
    // Fixed slots inside the card keep asterisms apart and clear of the caption and legend.
    const slots = mobile ? [[.3, .3], [.68, .55], [.32, .8]] : [[.24, .3], [.74, .28], [.5, .58], [.2, .72], [.8, .7], [.5, .22]];
    groups = state.sky.asterisms.slice(0, mobile ? 3 : slots.length).map((a, i) => {
      const [sx, sy] = slots[i];
      const cx = w * (sx + (hash(a.token, 7) - .5) * .04);
      const cy = h * (sy + (hash(a.token, 9) - .5) * .04);
      return { ...a, cx, cy, r: (mobile ? 26 : 38) + a.wallets.length * 3, members: [] };
    });
    const member = new Map();
    groups.forEach((gr) => gr.wallets.forEach((addr) => { if (!member.has(addr)) member.set(addr, gr); }));
    const known = new Set(state.sky.stars.map((s) => s.a));
    const live = [...extra.values()].filter((s) => !known.has(s.a));
    // The card shows the most active wallets (the API sorts by volume) plus asterism members.
    const shown = state.sky.stars.filter((s, i) => i < 700 || member.has(s.a));
    stars = [...shown, ...live].map((s) => {
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
      const base = { A: 1.9, B: 1.5, c: 1.1, C: 1.1, x: .7 }[tier];
      const size = base + (tier === "x" ? 0 : Math.min(.8, Math.log10((s.vol || 0) + 10) * .15));
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
    flares.push({ star, t0: now, color: trade.noise ? '240,138,122' : trade.side === 'buy' ? '244,184,96' : '238,241,248', big: trade.usd >= 1000 });
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
      if (s.tier === 'A' || s.gr) {
        const gs = s.size * 6;
        ctx.globalAlpha = a * .35;
        ctx.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = s.gr ? '#ffe6bf' : '#eef1f8';
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
    document.documentElement.style.overflow = '';
  }

  async function open(address) {
    if (!address) return;
    current = address;
    root.hidden = false;
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
  $$('.live-dot').forEach((d) => (d.style.background = 'var(--muted)'));
  const eyebrow = $('[data-eyebrow]');
  if (eyebrow) eyebrow.textContent = `Snapshot · ${at}`;
  const title = $('[data-tape-title]');
  if (title) title.textContent = 'Trade tape · snapshot';
  const meta = $('[data-tape-meta]');
  if (meta) meta.textContent = at;
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
    toggle.textContent = hideNoise ? 'Show bots' : 'Hide bots';
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
  return {};
})();

// Active section in the header nav.
(() => {
  const links = $$('.nav a');
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
  }), { rootMargin: '-40% 0px -55% 0px' });
  ['how', 'live', 'wallets', 'faq'].forEach((id) => io.observe(document.getElementById(id)));
})();

load().catch((e) => console.error(e));
setInterval(() => load().catch(() => {}), 60_000);

// Deep link from Telegram alerts: /#w=<address> opens that wallet.
function openFromHash() {
  const match = location.hash.match(/^#w=([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (match) Drawer.open(match[1]);
}
addEventListener('hashchange', openFromHash);
openFromHash();
