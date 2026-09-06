import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the UI direction comparison sheet.
 *
 * Three treatments of the same screen with identical data, so the comparison is
 * about the design rather than about which mockup got the nicer numbers. The
 * Trade screen is used throughout because it is the densest thing in the
 * product and the one the whole application exists to serve — a direction that
 * cannot carry it cannot carry the app.
 *
 * Generated rather than hand-written so the real wordmark outlines can be
 * inlined from the brand assets instead of transcribed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Pull the guts out of a generated brand SVG so it can go in a <symbol>. */
function symbolFrom(rel, id) {
  const file = readFileSync(join(HERE, 'assets', rel), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(file)?.[1] ?? '0 0 100 100';
  const inner = file.replace(/^[\s\S]*?role="img">/, '').replace(/<\/svg>\s*$/, '');
  return `<symbol id="${id}" viewBox="${viewBox}">${inner}</symbol>`;
}

const SYMBOLS =
  `<svg width="0" height="0" style="position:absolute" aria-hidden="true">` +
  symbolFrom('favicon/favicon.svg', 'flt-mark') +
  symbolFrom('wordmark/flt-exchange.svg', 'flt-word') +
  `</svg>`;

/* ── The one screen, as data ──────────────────────────────────────────────── */

const NAV = ['Home', 'Markets', 'Trade', 'Portfolio', 'Activity'];

const ROWS = [
  { label: 'Expected output', value: '1,251.02 USDC', emphasis: true },
  { label: 'Minimum received', value: '1,244.77 USDC', hint: 'Slippage tolerance 0.50%' },
  { label: 'Price impact', value: '0.08%', hint: 'Estimate' },
  { label: 'Network fee', value: '~0.000042 ETH', hint: 'Paid to the network by you, not to FLT' },
  { label: 'FLT fee', value: 'None' },
];

const ROUTE = [
  ['Liquidity source', 'AERODROME 68% · UNISWAP V3 32%'],
  ['Routed by', 'zeroex'],
];

const SIGNING = [
  ['Signing wallet', '0x742d…f44e'],
  ['Contract being called', '0x0000…C22734'],
];

/**
 * One mockup, rendered with a direction's scope class.
 *
 * Structure is identical across all three; only the CSS differs. That is the
 * point — it isolates the treatment from the information design, which is
 * already settled and is not what is being chosen here.
 */
function mockup(scope) {
  const rows = ROWS.map(
    (r) => `<div class="row${r.emphasis ? ' em' : ''}">
      <div class="rl"><span>${r.label}</span>${r.hint ? `<em>${r.hint}</em>` : ''}</div>
      <div class="rv">${r.value}</div>
    </div>`,
  ).join('');

  const route = ROUTE.map(
    ([l, v]) => `<div class="row"><div class="rl"><span>${l}</span></div><div class="rv mono">${v}</div></div>`,
  ).join('');

  const signing = SIGNING.map(
    ([l, v]) => `<div class="sign"><span>${l}</span><code>${v}</code></div>`,
  ).join('');

  return `<div class="mock ${scope}">
    <div class="chrome">
      <div class="logo">
        <svg class="m"><use href="#flt-mark"/></svg>
        <svg class="w"><use href="#flt-word"/></svg>
      </div>
      <nav>${NAV.map((n) => `<a class="${n === 'Trade' ? 'on' : ''}">${n}</a>`).join('')}</nav>
      <div class="acct">0x742d…f44e</div>
    </div>

    <div class="body">
      <div class="panel swap">
        <h3>Trade</h3>

        <div class="leg">
          <label>You pay</label>
          <div class="amt"><input value="0.5" readonly><span class="tok">ETH</span></div>
          <div class="bal">Balance 1.284 ETH</div>
        </div>

        <div class="swapline"><span class="arrow">↓</span></div>

        <div class="leg">
          <label>You receive</label>
          <div class="amt"><input value="1,251.02" readonly><span class="tok">USDC</span></div>
          <div class="bal">≈ $1,251.02</div>
        </div>

        <button class="cta">Review trade</button>
        <p class="custody">FLT never holds your assets. This is signed in your wallet.</p>
      </div>

      <div class="panel detail">
        <h3>Execution details</h3>
        <div class="group">${rows}</div>
        <div class="group">${route}</div>
        <div class="group last">
          <h4>What you are signing</h4>
          ${signing}
        </div>
      </div>
    </div>
  </div>`;
}

/* ── Direction copy ───────────────────────────────────────────────────────── */

const DIRECTIONS = [
  {
    scope: 'dir-a',
    index: 'A',
    name: 'Instrument',
    tagline: 'The brand taken literally',
    body: `Pure black, the same ground the logo lives on. No cards — hairline rules and
      whitespace do the separating, so the figures are the only thing with visual weight.
      Every number is monospaced and column-aligned. Labels are small, uppercase, wide-tracked.
      <strong>Closest to the identity you just chose</strong>, and the most confident reading of
      "faster than light": this is an instrument panel, not a website.`,
    palette: ['#000000', '#0a0a0b', '#1c1c1f', '#e6e7ea', '#7a7d85', '#4ec9e0'],
    type: 'Barlow Semi Condensed · IBM Plex Mono',
    risk: 'Density is a commitment. It reads as expert software, which is right for the product but unforgiving on small screens and for first-time users.',
    effort: 'Largest change. Rebuilds Card, Table and DetailRow around rules instead of surfaces, and moves every figure to a mono stack.',
  },
  {
    scope: 'dir-b',
    index: 'B',
    name: 'Console',
    tagline: 'What you have, done properly',
    body: `Keeps the layered dark surfaces the app already uses, but tightens them: a cooler,
      blue-biased neutral ramp, a real elevation scale instead of one card style repeated, and
      Chakra Petch on headings to carry the techno character down from the logo. Figures move to
      mono. <strong>The safe evolution</strong> — recognisably the same product, visibly more
      considered.`,
    palette: ['#0b0d12', '#14171e', '#232833', '#e8ebf0', '#8a93a3', '#6e8bff'],
    type: 'Chakra Petch · Inter · IBM Plex Mono',
    risk: 'The least distinctive of the three. Done well it looks like a good pro-trading app; it will not look like only your product.',
    effort: 'Smallest change. Mostly token values plus a heading face — the component structure survives intact.',
  },
  {
    scope: 'dir-c',
    index: 'C',
    name: 'Statement',
    tagline: 'Furthest from crypto',
    body: `Light-first, document-shaped. Trades read as records rather than as a live terminal:
      generous margins, a clear editorial hierarchy, serif for prose and mono for every figure.
      Answers the brief's "serious financial infrastructure, not a crypto casino" by simply not
      looking like crypto at all — this is closer to a prime broker's confirmation than to an
      exchange.`,
    palette: ['#f7f8fa', '#ffffff', '#dfe3ea', '#12151b', '#5c6473', '#1f4fd8'],
    type: 'IBM Plex Sans · IBM Plex Serif · IBM Plex Mono',
    risk: 'The logo is drawn for black. It works inverted, but the star-field world does not come with it, so this direction quietly drops the FTL atmosphere.',
    effort: 'Large. A light-first default inverts assumptions across every component, and the dark theme becomes the secondary one to maintain.',
  },
];

const cards = DIRECTIONS.map(
  (d) => `<section class="dir">
    <div class="dirhead">
      <span class="idx">${d.index}</span>
      <div>
        <h2>${d.name}</h2>
        <p class="tagline">${d.tagline}</p>
      </div>
      <div class="swatches">${d.palette
        .map((c) => `<i style="background:${c}" title="${c}"></i>`)
        .join('')}</div>
    </div>

    <p class="lede">${d.body}</p>

    <div class="stage">${mockup(d.scope)}</div>

    <dl class="meta">
      <div><dt>Type</dt><dd>${d.type}</dd></div>
      <div><dt>Trade-off</dt><dd>${d.risk}</dd></div>
      <div><dt>Cost to build</dt><dd>${d.effort}</dd></div>
    </dl>
  </section>`,
).join('');

/* ── Page ─────────────────────────────────────────────────────────────────── */

const html = `<title>FLT-Exchange UI Directions</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;500;600&family=Chakra+Petch:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:ital,wght@0,400;1,400&family=Inter:wght@400;500;600&display=swap">
<style>
  /*
   * The sheet itself is deliberately quiet and committed to one dark theme: the
   * mockups carry three competing palettes, and a page that also changed with
   * the viewer's OS would make them impossible to compare.
   */
  :root {
    --ground:#0a0b0d; --panel:#131519; --line:#232833;
    --ink:#e8ebf0; --dim:#7c8595; --accent:#5b8bff;
    --sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    color-scheme: dark;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font-family:var(--sans);
    font-size:15px; line-height:1.62; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1180px; margin:0 auto; padding:64px 28px 120px; }

  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.16em;
    text-transform:uppercase; color:var(--accent); margin:0 0 14px; }
  h1 { font-size:clamp(28px,4vw,40px); line-height:1.12; letter-spacing:-.025em;
    font-weight:600; margin:0 0 16px; text-wrap:balance; }
  .intro { color:var(--dim); margin:0 0 14px; max-width:68ch; font-size:16px; }
  .intro strong { color:var(--ink); font-weight:500; }

  .note { border-left:2px solid var(--accent); background:#16191e; padding:16px 20px;
    border-radius:0 8px 8px 0; margin:32px 0 0; font-size:14px; color:var(--dim); max-width:76ch; }
  .note strong { color:var(--ink); font-weight:500; }

  .dir { margin-top:76px; padding-top:34px; border-top:1px solid var(--line); }
  .dirhead { display:flex; align-items:flex-start; gap:16px; }
  .idx { font-family:var(--mono); font-size:12px; color:var(--accent); padding-top:6px; }
  .dirhead h2 { font-size:23px; font-weight:600; letter-spacing:-.02em; margin:0; }
  .tagline { margin:1px 0 0; color:var(--dim); font-size:14px; }
  .swatches { margin-left:auto; display:flex; gap:0; border-radius:5px; overflow:hidden;
    border:1px solid var(--line); }
  .swatches i { width:26px; height:26px; display:block; }
  .lede { color:var(--dim); font-size:14.5px; margin:16px 0 24px; max-width:76ch; }
  .lede strong { color:var(--ink); font-weight:500; }

  .stage { border:1px solid var(--line); border-radius:12px; overflow:hidden; }

  .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:1px;
    background:var(--line); border:1px solid var(--line); border-top:0;
    border-radius:0 0 10px 10px; margin:0; overflow:hidden; }
  .meta > div { background:var(--panel); padding:14px 16px; }
  .meta dt { font-family:var(--mono); font-size:10px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--dim); margin:0 0 5px; }
  .meta dd { margin:0; font-size:13.5px; line-height:1.5; }

  /* ══ Mockup: shared structure. Every visual value is set per direction. ══ */
  .mock { display:block; }
  .mock .chrome { display:flex; align-items:center; gap:22px; }
  .mock .logo { display:inline-flex; align-items:center; gap:10px; }
  .mock .logo .m { width:15px; height:11px; }
  .mock .logo .w { width:118px; height:11px; }
  .mock nav { display:flex; gap:2px; }
  .mock nav a { padding:5px 11px; border-radius:6px; cursor:default; }
  .mock .acct { margin-left:auto; font-family:var(--mono); }
  .mock .body { display:grid; grid-template-columns:minmax(0,0.95fr) minmax(0,1.05fr); }
  .mock h3 { margin:0; }
  .mock .leg label { display:block; }
  .mock .amt { display:flex; align-items:baseline; gap:8px; }
  .mock .amt input { border:0; background:transparent; width:100%; min-width:0;
    font-family:inherit; padding:0; outline:none; }
  .mock .row { display:flex; align-items:baseline; justify-content:space-between; gap:20px; }
  .mock .rl { display:flex; flex-direction:column; }
  .mock .rl em { font-style:normal; }
  .mock .rv { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .mock .sign { display:flex; align-items:baseline; justify-content:space-between; gap:16px; }
  .mock .cta { width:100%; border:0; cursor:default; font-family:inherit; }
  .mock .swapline { display:flex; justify-content:center; }

  @media (max-width:860px) { .mock .body { grid-template-columns:1fr; } }

  /* ══ A · Instrument ═══════════════════════════════════════════════════════ */
  .dir-a { background:#000; color:#e6e7ea;
    font-family:"Barlow Semi Condensed",var(--sans); }
  .dir-a .chrome { padding:11px 20px; border-bottom:1px solid #1c1c1f; }
  .dir-a .logo { color:#fff; }
  .dir-a nav a { font-size:12px; letter-spacing:.1em; text-transform:uppercase;
    color:#7a7d85; border-radius:0; padding:5px 10px; }
  .dir-a nav a.on { color:#fff; box-shadow:inset 0 -1px 0 #4ec9e0; }
  .dir-a .acct { font-size:11px; color:#7a7d85; }
  .dir-a .body { border-top:0; }
  .dir-a .panel { padding:22px 24px; }
  .dir-a .swap { border-right:1px solid #1c1c1f; }
  .dir-a h3 { font-size:11px; letter-spacing:.18em; text-transform:uppercase;
    color:#7a7d85; font-weight:500; margin-bottom:20px; }
  .dir-a .leg { padding:12px 0; border-bottom:1px solid #1c1c1f; }
  .dir-a .leg label { font-size:10px; letter-spacing:.14em; text-transform:uppercase;
    color:#7a7d85; margin-bottom:7px; }
  .dir-a .amt input { font-family:var(--mono); font-size:27px; color:#fff; font-weight:400; }
  .dir-a .tok { font-family:var(--mono); font-size:13px; color:#7a7d85; letter-spacing:.06em; }
  .dir-a .bal { font-family:var(--mono); font-size:10.5px; color:#5a5d64; margin-top:7px; }
  .dir-a .swapline { padding:9px 0; }
  .dir-a .arrow { color:#4ec9e0; font-size:13px; }
  .dir-a .cta { margin-top:22px; background:#4ec9e0; color:#000; padding:11px;
    font-size:12px; letter-spacing:.14em; text-transform:uppercase; font-weight:600;
    border-radius:2px; }
  .dir-a .custody { font-size:10.5px; color:#5a5d64; margin:12px 0 0; line-height:1.55; }
  .dir-a .group { padding:11px 0; border-bottom:1px solid #1c1c1f; }
  .dir-a .group.last { border-bottom:0; }
  .dir-a .row { padding:4px 0; }
  .dir-a .rl span { font-size:12px; color:#7a7d85; letter-spacing:.02em; }
  .dir-a .rl em { font-size:10px; color:#4a4d54; margin-top:1px; }
  .dir-a .rv { font-family:var(--mono); font-size:12.5px; color:#c9cbd1; }
  .dir-a .row.em .rv { color:#fff; font-size:14px; }
  .dir-a .row.em .rl span { color:#e6e7ea; }
  .dir-a .rv.mono { font-size:10.5px; color:#7a7d85; letter-spacing:.04em; }
  .dir-a h4 { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:#7a7d85;
    margin:0 0 9px; font-weight:500; }
  .dir-a .sign { padding:4px 0; }
  .dir-a .sign span { font-size:11.5px; color:#5a5d64; }
  .dir-a .sign code { font-family:var(--mono); font-size:10.5px; color:#c9cbd1; }

  /* ══ B · Console ══════════════════════════════════════════════════════════ */
  .dir-b { background:#0b0d12; color:#e8ebf0; font-family:"Inter",var(--sans); }
  .dir-b .chrome { padding:13px 20px; background:#0e1116; border-bottom:1px solid #1c212b; }
  .dir-b .logo { color:#e8ebf0; }
  .dir-b nav a { font-size:13px; color:#8a93a3; font-weight:500; }
  .dir-b nav a.on { color:#e8ebf0; background:#1a1f29; }
  .dir-b .acct { font-size:11.5px; color:#8a93a3; background:#14171e;
    border:1px solid #232833; padding:5px 10px; border-radius:6px; }
  .dir-b .body { gap:14px; padding:18px 20px; }
  .dir-b .panel { background:#14171e; border:1px solid #232833; border-radius:11px;
    padding:19px 21px; }
  .dir-b h3 { font-family:"Chakra Petch",var(--sans); font-size:15px; font-weight:600;
    letter-spacing:.01em; margin-bottom:16px; }
  .dir-b .leg { background:#0f1218; border:1px solid #1e232d; border-radius:9px;
    padding:13px 15px; }
  .dir-b .leg label { font-size:11.5px; color:#8a93a3; margin-bottom:6px; font-weight:500; }
  .dir-b .amt input { font-family:var(--mono); font-size:25px; color:#fff; }
  .dir-b .tok { font-family:"Chakra Petch",var(--sans); font-size:14px; color:#e8ebf0;
    background:#1c2029; padding:4px 9px; border-radius:6px; font-weight:600; }
  .dir-b .bal { font-size:11px; color:#6b7484; margin-top:7px; font-variant-numeric:tabular-nums; }
  .dir-b .swapline { padding:7px 0; }
  .dir-b .arrow { color:#6e8bff; background:#14171e; border:1px solid #232833;
    width:26px; height:26px; border-radius:8px; display:grid; place-items:center; font-size:12px; }
  .dir-b .cta { margin-top:16px; background:#6e8bff; color:#0b0d12; padding:11px;
    border-radius:9px; font-size:13.5px; font-weight:600; }
  .dir-b .custody { font-size:11px; color:#6b7484; margin:11px 0 0; line-height:1.55; }
  .dir-b .group { padding:9px 0; border-bottom:1px solid #1e232d; }
  .dir-b .group.last { border-bottom:0; padding-bottom:0; }
  .dir-b .row { padding:5px 0; }
  .dir-b .rl span { font-size:12.5px; color:#8a93a3; }
  .dir-b .rl em { font-size:10.5px; color:#5b6373; margin-top:1px; }
  .dir-b .rv { font-family:var(--mono); font-size:12.5px; color:#dfe3ea; }
  .dir-b .row.em .rv { color:#fff; font-size:14.5px; }
  .dir-b .rv.mono { font-size:10.5px; color:#8a93a3; }
  .dir-b h4 { font-family:"Chakra Petch",var(--sans); font-size:12px; color:#8a93a3;
    margin:0 0 9px; font-weight:600; letter-spacing:.03em; }
  .dir-b .sign { padding:4px 0; }
  .dir-b .sign span { font-size:12px; color:#6b7484; }
  .dir-b .sign code { font-family:var(--mono); font-size:11px; color:#dfe3ea; }

  /* ══ C · Statement ════════════════════════════════════════════════════════ */
  .dir-c { background:#f7f8fa; color:#12151b; font-family:"IBM Plex Sans",var(--sans); }
  .dir-c .chrome { padding:14px 26px; background:#fff; border-bottom:1px solid #dfe3ea; }
  .dir-c .logo { color:#12151b; }
  .dir-c nav a { font-size:13px; color:#5c6473; }
  .dir-c nav a.on { color:#12151b; font-weight:600; box-shadow:inset 0 -2px 0 #1f4fd8; border-radius:0; }
  .dir-c .acct { font-size:11.5px; color:#5c6473; }
  .dir-c .body { gap:30px; padding:28px 26px 26px; }
  .dir-c .panel { background:transparent; }
  .dir-c .swap { border-right:1px solid #dfe3ea; padding-right:30px; }
  .dir-c h3 { font-family:"IBM Plex Serif",Georgia,serif; font-size:19px; font-weight:400;
    margin-bottom:18px; letter-spacing:-.01em; }
  .dir-c .leg { background:#fff; border:1px solid #dfe3ea; border-radius:8px; padding:14px 16px; }
  .dir-c .leg label { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase;
    color:#5c6473; margin-bottom:7px; font-weight:500; }
  .dir-c .amt input { font-family:var(--mono); font-size:25px; color:#12151b; }
  .dir-c .tok { font-family:var(--mono); font-size:13px; color:#5c6473; }
  .dir-c .bal { font-size:11px; color:#7c8595; margin-top:7px; font-variant-numeric:tabular-nums; }
  .dir-c .swapline { padding:8px 0; }
  .dir-c .arrow { color:#5c6473; font-size:13px; }
  .dir-c .cta { margin-top:18px; background:#12151b; color:#fff; padding:12px;
    border-radius:7px; font-size:13.5px; font-weight:500; }
  .dir-c .custody { font-family:"IBM Plex Serif",Georgia,serif; font-size:12px; color:#5c6473;
    margin:12px 0 0; line-height:1.6; font-style:italic; }
  .dir-c .group { padding:10px 0; border-bottom:1px solid #e6e9ef; }
  .dir-c .group.last { border-bottom:0; }
  .dir-c .row { padding:5px 0; }
  .dir-c .rl span { font-size:13px; color:#5c6473; }
  .dir-c .rl em { font-size:11px; color:#8a92a1; margin-top:1px; }
  .dir-c .rv { font-family:var(--mono); font-size:12.5px; color:#12151b; }
  .dir-c .row.em .rv { font-size:15px; font-weight:500; }
  .dir-c .row.em .rl span { color:#12151b; font-weight:500; }
  .dir-c .rv.mono { font-size:10.5px; color:#5c6473; }
  .dir-c h4 { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:#5c6473;
    margin:0 0 9px; font-weight:600; }
  .dir-c .sign { padding:4px 0; }
  .dir-c .sign span { font-size:12.5px; color:#5c6473; }
  .dir-c .sign code { font-family:var(--mono); font-size:11px; color:#12151b; }
</style>

${SYMBOLS}

<div class="wrap">
  <header>
    <p class="eyebrow">UI direction · 06 September 2026</p>
    <h1>Three ways to build the interface</h1>
    <p class="intro">The identity is settled; the interface predates it. What is running now is
      clean but generic — it would suit any fintech product, and nothing in it says
      <strong>faster than light</strong>. These are three directions that would.</p>
    <p class="intro">Each one renders the same screen with the same numbers, so the comparison is
      about the treatment rather than about which mockup got the better data. The Trade screen is
      used throughout because it is the densest thing in the product and the one everything else
      exists to serve — a direction that cannot carry it cannot carry the app.</p>

    <div class="note">
      <strong>One decision underlies all three.</strong> Arkitech is a display face: wide,
      geometric, and without the tabular figures a balance column needs. It also almost certainly
      is not covered for webfont embedding by a desktop licence. In every direction below it stays
      in the logo, and a companion family does the interface work — which is normal practice, not
      a compromise.
    </div>
  </header>

  ${cards}

  <section class="dir">
    <div class="dirhead"><span class="idx">→</span><div><h2>What I would pick</h2>
      <p class="tagline">And what I would do about the risk</p></div></div>
    <p class="lede"><strong>A, Instrument.</strong> You chose the most distinctive mark of the five
      on offer, and the brand you already run is black, wide and technical — a layered card UI
      argues with all of it. Instrument is also the only one of the three that could not belong to
      another company, which is the whole reason to overhaul rather than tidy.</p>
    <p class="lede">Its real risk is density on small screens, and that is solvable rather than
      inherent: the same rules-and-figures treatment relaxes into a single column on mobile without
      changing character. <strong>B is the honest fallback</strong> if you want the improvement
      without the rebuild — it is a few days rather than a couple of weeks, and it keeps every
      component in place.</p>
    <p class="lede">I would drop C unless you are planning to sell to institutions, where a
      statement-shaped product is genuinely the right register. It reads well, but it throws away
      the atmosphere the identity just bought you.</p>
  </section>
</div>
`;

writeFileSync(join(HERE, 'ui-directions.html'), html, 'utf8');
console.log('brand/ui-directions.html');
