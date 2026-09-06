import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds a self-contained brand sheet from the generated assets.
 *
 * Everything is inlined — SVG as markup, PNG as a data URI — so the page can be
 * published or handed to a printer as one file and still render. Treated as a
 * spec sheet: the artwork is the subject, so the page around it stays quiet.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, 'assets');

const svg = (rel) => readFileSync(join(ASSETS, rel), 'utf8').trim();
const dataUri = (rel, mime = 'image/png') =>
  `data:${mime};base64,${readFileSync(join(ASSETS, rel)).toString('base64')}`;
const bytes = (rel) => {
  const n = readFileSync(join(ASSETS, rel)).length;
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
};

function section(id, index, title, lede, inner) {
  return `<section id="${id}">
    <div class="head"><span class="idx">${index}</span><h2>${title}</h2></div>
    <p class="lede">${lede}</p>
    ${inner}
  </section>`;
}

function figure(markup, name, why, { flush = false, invert = false, tall = false } = {}) {
  const cls = ['frame', flush && 'flush', invert && 'invert', tall && 'tall'].filter(Boolean).join(' ');
  return `<figure><div class="${cls}">${markup}</div>
    <figcaption><span class="name">${name}</span><span class="why">${why}</span><code>${bytes(
      arguments[3]?.file ?? '',
    )}</code></figcaption></figure>`;
}

/* ── The mark, at the sizes it is actually seen ───────────────────────────── */

const favSvg = svg('favicon/favicon-16.svg');
const ladder = [16, 20, 32, 48, 64]
  .map(
    (s) =>
      `<div class="fav"><div class="favbox" style="width:${s}px;height:${s}px">${favSvg}</div><span>${s}</span></div>`,
  )
  .join('');

const rasterLadder = [
  ['favicon/favicon-16.png', 16],
  ['favicon/favicon-32.png', 32],
  ['favicon/favicon-48.png', 48],
]
  .map(
    ([file, s]) =>
      `<div class="fav"><img src="${dataUri(file)}" width="${s}" height="${s}" alt=""><span>${s}</span></div>`,
  )
  .join('');

/* ── Files table ──────────────────────────────────────────────────────────── */

const FILES = [
  ['favicon/favicon.svg', 'Mark, inherits colour', 'Embedding in a document'],
  ['favicon/favicon-16.svg', 'Mark, theme-aware fill', 'Browser tab — shipped as icon.svg'],
  ['favicon/favicon.ico', '16 · 32 · 48 bundled', 'Older Windows browsers'],
  ['icon/app.svg', 'Rounded square, black', 'Source for the raster icons'],
  ['icon/apple-touch-icon.png', '180 × 180', 'iOS home screen'],
  ['icon/icon-192.png', '192 × 192', 'PWA manifest'],
  ['icon/icon-512.png', '512 × 512', 'PWA manifest, splash'],
  ['icon/maskable-512.png', '512 × 512, inset', 'Android adaptive icon'],
  ['lockup/primary.svg', 'Mark + wordmark, Light', 'Primary logo'],
  ['lockup/primary-medium.svg', 'Mark + wordmark, Medium', 'Small or one-colour reproduction'],
  ['lockup/short.svg', 'Mark + FLT', 'Tight spaces'],
  ['lockup/stacked.svg', 'Stacked', 'Square formats, print'],
  ['wordmark/flt-exchange.svg', 'Wordmark only', 'Where the mark already appears'],
  ['social/og.png', '1200 × 630', 'Link previews'],
]
  .filter(([file]) => existsSync(join(ASSETS, file)))
  .map(
    ([file, what, where]) =>
      `<tr><td><code>${file}</code></td><td>${what}</td><td>${where}</td><td class="num">${bytes(file)}</td></tr>`,
  )
  .join('');

const html = `<title>FLT-Exchange Brand Sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  /*
   * Committed single theme. The identity is white-on-black, so the sheet is
   * presented in the world the marks live in; the inversion test gets its own
   * section rather than being left to the viewer's OS setting.
   */
  :root {
    --ground:#0a0b0d; --panel:#131519; --panel-2:#16191e; --line:#232833;
    --ink:#e8ebf0; --dim:#7c8595; --accent:#5b8bff;
    --sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    color-scheme: dark;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font-family:var(--sans);
    font-size:15px; line-height:1.62; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1140px; margin:0 auto; padding:64px 28px 120px; }

  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.16em;
    text-transform:uppercase; color:var(--accent); margin:0 0 14px; }
  h1 { font-size:clamp(28px,4vw,40px); line-height:1.12; letter-spacing:-.025em;
    font-weight:600; margin:0 0 16px; text-wrap:balance; }
  .intro { color:var(--dim); margin:0; max-width:66ch; font-size:16px; }
  .intro strong { color:var(--ink); font-weight:500; }

  .specs { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px;
    background:var(--line); border:1px solid var(--line); border-radius:10px;
    overflow:hidden; margin:40px 0 0; }
  .spec { background:var(--panel); padding:14px 16px; }
  .spec dt { font-family:var(--mono); font-size:10px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--dim); margin:0 0 4px; }
  .spec dd { margin:0; font-size:14px; font-weight:500; }

  section { margin-top:72px; }
  .head { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid var(--line);
    padding-bottom:10px; }
  .idx { font-family:var(--mono); font-size:12px; color:var(--accent); }
  h2 { font-size:19px; font-weight:600; letter-spacing:-.012em; margin:0; }
  .lede { color:var(--dim); font-size:14px; margin:14px 0 24px; max-width:72ch; }

  .grid { display:grid; gap:20px; grid-template-columns:repeat(auto-fill,minmax(268px,1fr)); }
  .grid.two { grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); }
  figure { margin:0; }
  figure.wide { grid-column:1/-1; }

  .frame { background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:30px; min-height:132px; color:#fff; display:flex; align-items:center;
    justify-content:center; overflow:hidden; }
  .frame.flush { padding:0; }
  .frame.tall { min-height:190px; }
  .frame.invert { background:#fff; color:#000; border-color:#d7dbe2; }
  .frame svg, .frame img { max-width:100%; height:auto; display:block; }

  figcaption { padding:11px 2px 0; display:flex; flex-direction:column; gap:1px; }
  .name { font-size:13.5px; font-weight:500; }
  .why { font-size:12.5px; color:var(--dim); }
  code { font-family:var(--mono); font-size:11px; color:#5e6674; }

  .ladder { display:flex; align-items:center; justify-content:space-between; gap:32px;
    flex-wrap:wrap; background:var(--panel); border:1px solid var(--line);
    border-radius:10px; padding:22px 24px; margin-bottom:12px; }
  .ladder-id { display:flex; flex-direction:column; gap:1px; }
  .ladder-sizes { display:flex; align-items:flex-end; gap:26px; color:#fff; }
  .fav { display:flex; flex-direction:column; align-items:center; gap:8px; }
  .favbox { display:block; }
  .favbox > svg { width:100%; height:100%; display:block; }
  .fav span { font-family:var(--mono); font-size:10px; color:var(--dim);
    font-variant-numeric:tabular-nums; }
  .fav img { image-rendering:pixelated; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-family:var(--mono); font-size:10px; letter-spacing:.1em;
    text-transform:uppercase; color:var(--dim); font-weight:500;
    padding:0 14px 10px 0; border-bottom:1px solid var(--line); }
  td { padding:11px 14px 11px 0; border-bottom:1px solid var(--line); color:var(--dim); }
  td:nth-child(2) { color:var(--ink); }
  td.num { text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums;
    padding-right:0; }
  .scroll { overflow-x:auto; }

  .callout { border-left:2px solid var(--accent); background:var(--panel-2);
    padding:16px 20px; border-radius:0 8px 8px 0; margin-top:28px; font-size:14px;
    color:var(--dim); }
  .callout strong { color:var(--ink); font-weight:500; }

  @media (max-width:640px){ .ladder{justify-content:flex-start} .ladder-sizes{gap:18px} }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">Brand sheet · 06 September 2026</p>
    <h1>FLT-Exchange</h1>
    <p class="intro">The <strong>stagger</strong> mark, adopted throughout. Arkitech sheared 12° to
      sit alongside FTL-Pay, drawn as outlines so nothing depends on the font being installed.
      Every file below is generated from <code>brand/generate.mjs</code> — the geometry is defined
      once, so changing the shear or the bar proportions reflows the whole set.</p>

    <dl class="specs">
      <div class="spec"><dt>Mark</dt><dd>Stagger</dd></div>
      <div class="spec"><dt>Typeface</dt><dd>Arkitech Light</dd></div>
      <div class="spec"><dt>Shear</dt><dd>12°</dd></div>
      <div class="spec"><dt>Bars</dt><dd>100 · 45 · 80</dd></div>
      <div class="spec"><dt>Ground</dt><dd>#000000</dd></div>
    </dl>
  </header>

  ${section(
    'mark',
    '01',
    'The mark',
    'Three bars at descending-then-rising lengths. It carries the brand alone wherever the wordmark will not fit. The tab icon is a separate drawing rather than this one scaled down — at 16px the standard bar weight lands under three pixels and greys out, so the bars are thickened and the gaps opened.',
    `<div class="ladder">
      <div class="ladder-id"><span class="name">Vector</span><span class="why">Theme-aware fill; shipped as icon.svg</span><code>favicon-16.svg · ${bytes(
        'favicon/favicon-16.svg',
      )}</code></div>
      <div class="ladder-sizes">${ladder}</div>
    </div>
    <div class="ladder">
      <div class="ladder-id"><span class="name">Raster</span><span class="why">Bundled into favicon.ico for older browsers</span><code>favicon.ico · ${bytes(
        'favicon/favicon.ico',
      )}</code></div>
      <div class="ladder-sizes">${rasterLadder}</div>
    </div>`,
  )}

  ${section(
    'icons',
    '02',
    'App icons',
    'Home screens, PWA install and the tab strip. The maskable version is inset further because Android crops adaptive icons to a circle — reusing the standard icon would clip the outer bar.',
    `<div class="grid">
      <figure><div class="frame flush">${svg('icon/app.svg')}</div>
        <figcaption><span class="name">App icon</span><span class="why">Rounded square</span><code>icon/app.svg</code></figcaption></figure>
      <figure><div class="frame flush">${svg('icon/maskable.svg')}</div>
        <figcaption><span class="name">Maskable</span><span class="why">Safe inside a circular crop</span><code>icon/maskable.svg</code></figcaption></figure>
      <figure><div class="frame"><img src="${dataUri('icon/apple-touch-icon.png')}" width="180" height="180" alt=""></div>
        <figcaption><span class="name">Apple touch icon</span><span class="why">180 × 180</span><code>icon/apple-touch-icon.png</code></figcaption></figure>
    </div>`,
  )}

  ${section(
    'lockup',
    '03',
    'Primary lockup',
    'The everyday logo. The mark is set to the cap height of the letters and leans at the same angle, so the two read as one object rather than an icon parked next to some type.',
    `<div class="grid two">
      <figure><div class="frame">${svg('lockup/primary.svg')}</div>
        <figcaption><span class="name">Primary</span><span class="why">Arkitech Light</span><code>lockup/primary.svg</code></figcaption></figure>
      <figure><div class="frame invert">${svg('lockup/primary.svg')}</div>
        <figcaption><span class="name">On white</span><span class="why">Invoices, statements, print</span><code>same file</code></figcaption></figure>
      <figure><div class="frame">${svg('lockup/primary-medium.svg')}</div>
        <figcaption><span class="name">Medium weight</span><span class="why">Small or one-colour reproduction</span><code>lockup/primary-medium.svg</code></figcaption></figure>
      <figure><div class="frame">${svg('lockup/short.svg')}</div>
        <figcaption><span class="name">Short form</span><span class="why">Collapsed sidebar, avatars</span><code>lockup/short.svg</code></figcaption></figure>
    </div>`,
  )}

  ${section(
    'wordmark',
    '04',
    'Wordmark and stacked',
    'The wordmark alone, for places the mark already appears nearby — an app header where the favicon is in the tab. The stacked lockup is for square formats.',
    `<div class="grid two">
      <figure><div class="frame">${svg('wordmark/flt-exchange.svg')}</div>
        <figcaption><span class="name">FLT-EXCHANGE</span><span class="why">Arkitech Light</span><code>wordmark/flt-exchange.svg</code></figcaption></figure>
      <figure><div class="frame tall">${svg('lockup/stacked.svg')}</div>
        <figcaption><span class="name">Stacked</span><span class="why">Square formats, print</span><code>lockup/stacked.svg</code></figcaption></figure>
    </div>`,
  )}

  ${section(
    'social',
    '05',
    'Social card',
    'Link previews, at the 1200 × 630 every platform expects. The star field is generated deterministically, so regenerating the file does not reshuffle the sky.',
    `<div class="grid"><figure class="wide"><div class="frame flush">
      <img src="${dataUri('social/og.png')}" width="1200" height="630" alt="FLT-Exchange social card">
    </div><figcaption><span class="name">Open Graph card</span><span class="why">1200 × 630 · served at /og.png</span><code>social/og.png · ${bytes(
      'social/og.png',
    )}</code></figcaption></figure></div>`,
  )}

  ${section(
    'files',
    '06',
    'Files',
    'What exists and where each one is used. Regenerate the whole set with <code>node brand/generate.mjs</code>; the Arkitech files are read from FONT_DIR and are deliberately not committed.',
    `<div class="scroll"><table>
      <thead><tr><th>File</th><th>What</th><th>Used for</th><th class="num">Size</th></tr></thead>
      <tbody>${FILES}</tbody>
    </table></div>`,
  )}

  <div class="callout">
    <strong>Wired through both applications.</strong> Favicon, tab icon, Apple touch icon, PWA
    manifest and Open Graph tags are live on the consumer app; the admin panel carries the mark with
    an "Admin" suffix and its own icons. The header logo is drawn from the same outlines as these
    files, so the interface cannot drift from the brand sheet.
  </div>
</div>
`;

writeFileSync(join(HERE, 'review.html'), html, 'utf8');
console.log('brand/review.html');
