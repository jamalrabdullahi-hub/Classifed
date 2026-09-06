import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds a single self-contained review sheet from the generated assets.
 *
 * Every SVG is inlined rather than linked, so the page can be published or sent
 * on as one file and still render. Treated as a spec sheet rather than a
 * showcase: the artwork is the subject, so the page around it stays quiet.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, 'assets');

const read = (rel) => readFileSync(join(ASSETS, rel), 'utf8').trim();
const list = (dir) =>
  existsSync(join(ASSETS, dir))
    ? readdirSync(join(ASSETS, dir)).filter((f) => f.endsWith('.svg'))
    : [];

/** Ordered deliberately: the two closest to FTL-Pay lead. */
const ORDER = ['short-middle', 'equal', 'accelerate', 'decelerate', 'stagger'];

const MARK_NOTES = {
  'short-middle': ['Short middle', 'Closest to the FTL-Pay mark'],
  equal: ['Equal', 'The most neutral reading'],
  accelerate: ['Accelerate', 'Bars lengthen downward'],
  decelerate: ['Decelerate', 'Bars shorten downward'],
  stagger: ['Stagger', 'Irregular, most distinctive'],
};

const variantOf = (file) =>
  ORDER.find((name) => file.includes(name)) ?? file.replace(/\.svg$/, '');

const byOrder = (a, b) => ORDER.indexOf(variantOf(a)) - ORDER.indexOf(variantOf(b));

const note = (file) => MARK_NOTES[variantOf(file)] ?? [variantOf(file), ''];

function tile(file, svgMarkup, { flush = false, invert = false } = {}) {
  const [name, why] = note(file);
  return `<figure>
      <div class="frame${flush ? ' flush' : ''}${invert ? ' invert' : ''}">${svgMarkup}</div>
      <figcaption><span class="name">${name}</span>${why ? `<span class="why">${why}</span>` : ''}<code>${file}</code></figcaption>
    </figure>`;
}

function section(id, index, title, lede, inner) {
  return `<section id="${id}">
    <div class="head"><span class="idx">${index}</span><h2>${title}</h2></div>
    <p class="lede">${lede}</p>
    ${inner}
  </section>`;
}

/* ── Favicon size ladder — the thing that was actually asked for ──────────── */

const faviconRows = list('favicon')
  .filter((f) => !f.includes('onblack'))
  .sort(byOrder)
  .map((file) => {
    const svg = read(`favicon/${file}`);
    const [name, why] = note(file);
    const sizes = [16, 20, 32, 48, 64]
      .map(
        (s) =>
          `<div class="fav"><div class="favbox" style="width:${s}px;height:${s}px">${svg}</div><span>${s}</span></div>`,
      )
      .join('');
    return `<div class="ladder">
        <div class="ladder-id"><span class="name">${name}</span><span class="why">${why}</span><code>${file}</code></div>
        <div class="ladder-sizes">${sizes}</div>
      </div>`;
  })
  .join('');

const icons = list('icon')
  .filter((f) => f.startsWith('app-'))
  .sort(byOrder)
  .map((f) => tile(f, read(`icon/${f}`), { flush: true }))
  .join('');

const lockupsLight = list('lockup')
  .filter((f) => f.startsWith('flt-exchange-') && !f.includes('medium'))
  .sort(byOrder);

const lockupGrid = lockupsLight.map((f) => tile(f, read(`lockup/${f}`))).join('');
const lockupInverted = lockupsLight
  .slice(0, 2)
  .map((f) => tile(f, read(`lockup/${f}`), { invert: true }))
  .join('');

const lockupsMedium = list('lockup')
  .filter((f) => f.includes('medium'))
  .sort(byOrder)
  .map((f) => tile(f, read(`lockup/${f}`)))
  .join('');

const shortForm = list('lockup')
  .filter((f) => /^flt-(equal|short-middle|accelerate|decelerate|stagger)\.svg$/.test(f))
  .sort(byOrder)
  .map((f) => tile(f, read(`lockup/${f}`)))
  .join('');

const stacked = existsSync(join(ASSETS, 'lockup/stacked.svg'))
  ? `<figure><div class="frame tall">${read('lockup/stacked.svg')}</div>
     <figcaption><span class="name">Stacked</span><span class="why">Square spaces and print</span><code>stacked.svg</code></figcaption></figure>`
  : '';

const wordmarks = list('wordmark')
  .map((f) => {
    const weight = f.includes('medium') ? 'Medium' : 'Light';
    const text = f.startsWith('flt.') ? 'FLT' : 'FLT-EXCHANGE';
    return `<figure><div class="frame">${read(`wordmark/${f}`)}</div>
      <figcaption><span class="name">${text}</span><span class="why">Arkitech ${weight}</span><code>${f}</code></figcaption></figure>`;
  })
  .join('');

const social = list('social')
  .map(
    (f) => `<figure class="wide"><div class="frame flush">${read(`social/${f}`)}</div>
      <figcaption><span class="name">${note(f)[0]}</span><span class="why">1200 × 630</span><code>${f}</code></figcaption></figure>`,
  )
  .join('');

const html = `<title>FLT-Exchange Identity</title>
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
    --ground:   #0a0b0d;
    --panel:    #131519;
    --panel-2:  #16191e;
    --line:     #232833;
    --ink:      #e8ebf0;
    --dim:      #7c8595;
    --accent:   #5b8bff;
    --sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    color-scheme: dark;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: 1140px; margin: 0 auto; padding: 64px 28px 120px; }

  /* ── Masthead ─────────────────────────────────────────────────────────── */
  header { margin-bottom: 8px; }
  .eyebrow {
    font-family: var(--mono); font-size: 11px; letter-spacing: .16em;
    text-transform: uppercase; color: var(--accent); margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(28px, 4vw, 40px); line-height: 1.12; letter-spacing: -.025em;
    font-weight: 600; margin: 0 0 16px; text-wrap: balance;
  }
  .intro { color: var(--dim); margin: 0; max-width: 66ch; font-size: 16px; }
  .intro strong { color: var(--ink); font-weight: 500; }

  .specs {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1px; background: var(--line); border: 1px solid var(--line);
    border-radius: 10px; overflow: hidden; margin: 40px 0 0;
  }
  .spec { background: var(--panel); padding: 14px 16px; }
  .spec dt {
    font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--dim); margin: 0 0 4px;
  }
  .spec dd { margin: 0; font-size: 14px; font-weight: 500; }

  /* ── Sections ─────────────────────────────────────────────────────────── */
  section { margin-top: 72px; }
  .head { display: flex; align-items: baseline; gap: 14px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
  .idx { font-family: var(--mono); font-size: 12px; color: var(--accent); }
  h2 { font-size: 19px; font-weight: 600; letter-spacing: -.012em; margin: 0; }
  .lede { color: var(--dim); font-size: 14px; margin: 14px 0 24px; max-width: 72ch; }

  .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); }
  .grid.two { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }

  figure { margin: 0; }
  figure.wide { grid-column: 1 / -1; }

  .frame {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 30px; min-height: 132px; color: #fff;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .frame.flush { padding: 0; }
  .frame.tall { min-height: 190px; }
  .frame.invert { background: #fff; color: #000; border-color: #d7dbe2; }
  .frame svg { max-width: 100%; height: auto; display: block; }

  figcaption { padding: 11px 2px 0; display: flex; flex-direction: column; gap: 1px; }
  .name { font-size: 13.5px; font-weight: 500; }
  .why { font-size: 12.5px; color: var(--dim); }
  code { font-family: var(--mono); font-size: 11px; color: #5e6674; margin-top: 3px; }

  /* ── Favicon ladder ───────────────────────────────────────────────────── */
  .ladder {
    display: flex; align-items: center; justify-content: space-between;
    gap: 32px; flex-wrap: wrap;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 20px 24px; margin-bottom: 12px;
  }
  .ladder-id { display: flex; flex-direction: column; gap: 1px; }
  .ladder-sizes { display: flex; align-items: flex-end; gap: 26px; color: #fff; }
  .fav { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  /* The inlined SVGs carry width/height attributes; the box overrides them. */
  .favbox { display: block; }
  .favbox > svg { width: 100%; height: 100%; display: block; }
  .fav span { font-family: var(--mono); font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; }

  .callout {
    border-left: 2px solid var(--accent); background: var(--panel-2);
    padding: 16px 20px; border-radius: 0 8px 8px 0; margin-top: 28px;
    font-size: 14px; color: var(--dim);
  }
  .callout strong { color: var(--ink); font-weight: 500; }

  @media (max-width: 640px) {
    .ladder { justify-content: flex-start; }
    .ladder-sizes { gap: 18px; }
  }
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">Identity proposal · 06 September 2026</p>
    <h1>FLT-Exchange</h1>
    <p class="intro">Arkitech, sheared 12° to sit alongside the FTL-Pay wordmark, drawn as
      outlines so nothing depends on the font being installed. Every mark below is a real
      SVG at production geometry, not a mockup. <strong>Nothing here is committed to</strong> —
      tell me which mark you want and I will wire it through the app and drop the rest.</p>

    <dl class="specs">
      <div class="spec"><dt>Typeface</dt><dd>Arkitech Light / Medium</dd></div>
      <div class="spec"><dt>Shear</dt><dd>12°</dd></div>
      <div class="spec"><dt>Mark</dt><dd>Three bars</dd></div>
      <div class="spec"><dt>Format</dt><dd>Outlined SVG</dd></div>
      <div class="spec"><dt>Variants</dt><dd>5 marks · 36 files</dd></div>
    </dl>
  </header>

  ${section(
    'favicon',
    '01',
    'Favicon — the mark alone',
    'What you asked for: just the dash lines. Shown at the sizes a browser actually renders, because that is the only test that matters — at 16px the wordmark is gone and this is all that is left. The bars thin out at the smallest size; if you pick one, I will thicken it specifically for 16px rather than letting the browser shrink the same file.',
    faviconRows,
  )}

  ${section(
    'app-icon',
    '02',
    'App icon',
    'Rounded square for home screens, PWA install and the browser tab strip. Maskable versions are generated alongside these for Android, which crops icons to a circle.',
    `<div class="grid">${icons}</div>`,
  )}

  ${section(
    'primary',
    '03',
    'Primary lockup',
    'The everyday logo, in Arkitech Light to match FTL-Pay. The mark is set to the cap height of the letters and leans at the same angle, so the two read as one object rather than an icon parked next to some type.',
    `<div class="grid two">${lockupGrid}</div>`,
  )}

  ${section(
    'inverted',
    '04',
    'On white',
    'The same lockup on a light ground. An identity that only survives on black is half an identity — invoices, statements and anything printed will be white.',
    `<div class="grid two">${lockupInverted}</div>`,
  )}

  ${section(
    'medium',
    '05',
    'Medium weight',
    'Arkitech Medium. Holds together better when reproduced small, embroidered, or printed in one colour — worth having even if Light stays the primary.',
    `<div class="grid two">${lockupsMedium}</div>`,
  )}

  ${section(
    'short',
    '06',
    'Short form and stacked',
    'FLT alone for tight spaces — a collapsed sidebar, an avatar, a favicon that still wants letters. The stacked lockup is for square formats.',
    `<div class="grid">${shortForm}${stacked}</div>`,
  )}

  ${section(
    'wordmark',
    '07',
    'Wordmark alone',
    'No mark, for places the icon already appears nearby — an app header where the favicon is in the tab, or a document footer.',
    `<div class="grid two">${wordmarks}</div>`,
  )}

  ${section(
    'social',
    '08',
    'Social card',
    'Link previews, at the 1200 × 630 every platform expects. The star field is generated deterministically, so regenerating the file does not reshuffle the sky.',
    `<div class="grid">${social}</div>`,
  )}

  <div class="callout">
    <strong>Two things to settle.</strong> The wordmark reads FLT-EXCHANGE, matching the codebase
    and your note that it stands for Faster Than Light — worth a look beside FTL-Pay, since the two
    acronyms differ. And these SVGs cover every modern browser; Safari and older Windows still want
    a PNG and an .ico, which I can generate once a mark is chosen.
  </div>
</div>
`;

writeFileSync(join(HERE, 'review.html'), html, 'utf8');
console.log('brand/review.html');
