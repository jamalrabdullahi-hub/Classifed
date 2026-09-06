import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

/**
 * Brand asset generator for FLT-Exchange.
 *
 * Renders the wordmark from the Arkitech typeface into outlined SVG paths.
 * Outlines rather than live text deliberately: a logo has to render identically
 * everywhere without shipping the font file, and Arkitech is licensed to FLT
 * rather than to whoever loads the page.
 *
 * The font is NOT committed to this repository. Point FONT_DIR at the licensed
 * copy:
 *   node brand/generate.mjs
 *   FONT_DIR="/path/to/arkitech-2-font" node brand/generate.mjs
 *
 * Two implementation notes worth keeping:
 *
 * opentype.js 2.0's Path.extend() corrupts coordinates when merging glyph paths
 * â€” the combined path comes back containing NaN even though every glyph is
 * clean on its own. Glyph path data is concatenated as strings instead.
 *
 * The oblique is an SVG transform rather than baked-into coordinates. Arkitech
 * ships no italic, so the slant on the existing FTL-Pay wordmark is a shear;
 * doing it as a transform keeps the mark and the letters leaning by exactly the
 * same angle and leaves the outlines untouched.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'assets');

const FONT_DIR = process.env.FONT_DIR ?? 'C:/FLT-Pay/media & logos/arktech-2/arkitech-2-font';

const loadFont = (file) => opentype.parse(readFileSync(join(FONT_DIR, file)).buffer);
const FONTS = {
  light: loadFont('ArkitechLight-ovWKz.otf'),
  medium: loadFont('ArkitechMedium-R9EYv.otf'),
};

/** Degrees of lean, matching the FTL-Pay wordmark. */
const SLANT = 12;
const TAN = Math.tan((SLANT * Math.PI) / 180);

const round = (n) => Number(n.toFixed(2));
/** Leans the top of a shape to the right; y grows downward in SVG. */
const skew = `skewX(${-SLANT})`;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Wordmark
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Outlines for a string, laid out on a baseline at y = 0.
 *
 * Returns SVG markup rather than a single path string, and un-slanted geometry;
 * callers apply the shear via transform.
 *
 * Every glyph is rendered at the origin and positioned with a transform, which
 * is the only arrangement opentype.js 2.0 gets right. Passing a non-zero x to
 * getPath, using the font-level getPath/getPaths helpers, or mutating the
 * returned command coordinates all yield NaN for a subset of glyphs â€” silently,
 * so letters simply vanish from the wordmark.
 */
function wordmark(font, text, size, { letterSpacing = 0 } = {}) {
  const scale = size / font.unitsPerEm;
  const parts = [];

  let x = 0;
  let capHeight = 0;
  let width = 0;

  for (const glyph of font.stringToGlyphs(text)) {
    const path = glyph.getPath(0, 0, size);
    const d = path.toPathData(3);

    // Guard rather than trust: a malformed glyph must not drop a letter out of
    // the wordmark without saying so.
    if (d && !d.includes('NaN')) {
      parts.push(`<path transform="translate(${round(x)} 0)" d="${d}"/>`);
      const box = path.getBoundingBox();
      if (Number.isFinite(box.y1)) capHeight = Math.max(capHeight, Math.abs(box.y1));
      if (Number.isFinite(box.x2)) width = Math.max(width, x + box.x2);
    } else {
      console.warn(`   ! skipped malformed glyph "${glyph.name}"`);
    }

    x += glyph.advanceWidth * scale + letterSpacing;
  }

  return { body: parts.join(''), width, capHeight };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The speed mark
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Three horizontal bars â€” the mark that carries the brand on its own.
 *
 * Each variant reads the same idea differently, which is why several ship: in a
 * favicon the wordmark is illegible and this is all that is left.
 */
const MARKS = {
  equal: [1, 1, 1],
  'short-middle': [1, 0.6, 1],
  accelerate: [0.5, 0.75, 1],
  decelerate: [1, 0.75, 0.5],
  stagger: [1, 0.45, 0.8],
};

const MARK_NAMES = Object.keys(MARKS);

/** Bars as axis-aligned rects; the caller skews them to match the letters. */
function speedMark(variant, unit, { weight = 0.17, gap = 0.145 } = {}) {
  const lengths = MARKS[variant] ?? MARKS.equal;
  const bar = unit * weight;
  const gapH = unit * gap;
  const height = bar * 3 + gapH * 2;

  const d = lengths
    .map((length, index) => {
      const y = index * (bar + gapH);
      return `M0 ${round(y)}h${round(unit * length)}v${round(bar)}h${round(-unit * length)}z`;
    })
    .join('');

  return { d, width: unit, height };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SVG helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function svg({ width, height, body, background }) {
  const bg = background ? `<rect width="${round(width)}" height="${round(height)}" fill="${background}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" ` +
    `width="${round(width)}" height="${round(height)}" fill="none" role="img">${bg}${body}</svg>\n`
  );
}

function write(name, contents) {
  const target = join(OUT, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  console.log('  ', name);
}

/**
 * A horizontal lockup: mark, gap, wordmark.
 *
 * Skewing shifts a shape left as y grows, so each group is nudged right by
 * height * tan to keep the artwork inside the viewBox.
 */
function lockup({ font, text, variant, size = 100, fill = 'currentColor', background }) {
  const word = wordmark(font, text, size, { letterSpacing: size * 0.02 });
  const markUnit = word.capHeight * 1.45;
  const mark = speedMark(variant, markUnit);

  // Scale the mark so its overall height matches the cap height of the letters.
  const scale = word.capHeight / mark.height;
  const markW = mark.width * scale;
  const markH = word.capHeight;

  const gap = size * 0.3;
  const pad = size * 0.18;
  const lean = markH * TAN;

  const width = pad * 2 + markW + gap + word.width + lean;
  const height = pad * 2 + word.capHeight;

  const body =
    `<g transform="translate(${round(pad + lean)} ${round(pad)}) ${skew}">` +
    `<g transform="scale(${round(scale)})"><path d="${mark.d}" fill="${fill}"/></g></g>` +
    `<g transform="translate(${round(pad + lean + markW + gap)} ${round(pad + word.capHeight)}) ${skew}" ` +
    `fill="${fill}">${word.body}</g>`;

  return { svg: svg({ width, height, body, background }), width, height, word, markW, mark, scale };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

mkdirSync(OUT, { recursive: true });
console.log('Generating FLT-Exchange brand assets...\n');

/* â”€â”€ Favicons and app icons: the mark alone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

for (const variant of MARK_NAMES) {
  const unit = 100;
  const mark = speedMark(variant, unit);
  const lean = mark.height * TAN;
  const pad = unit * 0.2;
  const box = Math.max(unit + lean, mark.height) + pad * 2;

  const place =
    `<g transform="translate(${round((box - unit - lean) / 2 + lean)} ${round((box - mark.height) / 2)}) ${skew}">`;

  write(
    `favicon/mark-${variant}.svg`,
    svg({ width: box, height: box, body: `${place}<path d="${mark.d}" fill="currentColor"/></g>` }),
  );

  write(
    `icon/app-${variant}.svg`,
    svg({
      width: box,
      height: box,
      body:
        `<rect width="${round(box)}" height="${round(box)}" rx="${round(box * 0.22)}" fill="#000"/>` +
        `${place}<path d="${mark.d}" fill="#fff"/></g>`,
    }),
  );

  // Maskable icon: Android crops to a circle, so the mark is inset further.
  write(
    `icon/maskable-${variant}.svg`,
    svg({
      width: box,
      height: box,
      body:
        `<rect width="${round(box)}" height="${round(box)}" fill="#000"/>` +
        `<g transform="translate(${round(box / 2)} ${round(box / 2)}) scale(0.66) translate(${round(-box / 2)} ${round(-box / 2)})">` +
        `${place}<path d="${mark.d}" fill="#fff"/></g></g>`,
    }),
  );
}

/* â”€â”€ Lockups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const WORDS = [
  { name: 'flt-exchange', text: 'FLT-EXCHANGE', font: FONTS.light },
  { name: 'flt-exchange-medium', text: 'FLT-EXCHANGE', font: FONTS.medium },
  { name: 'flt', text: 'FLT', font: FONTS.light },
];

for (const entry of WORDS) {
  for (const variant of MARK_NAMES) {
    write(
      `lockup/${entry.name}-${variant}.svg`,
      lockup({ font: entry.font, text: entry.text, variant }).svg,
    );
  }

  const word = wordmark(entry.font, entry.text, 100, { letterSpacing: 2 });
  const pad = 18;
  const lean = word.capHeight * TAN;
  write(
    `wordmark/${entry.name}.svg`,
    svg({
      width: pad * 2 + word.width + lean,
      height: pad * 2 + word.capHeight,
      body:
        `<g transform="translate(${round(pad + lean)} ${round(pad + word.capHeight)}) ${skew}" ` +
        `fill="currentColor">${word.body}</g>`,
    }),
  );
}

/* â”€â”€ Stacked lockup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

{
  const word = wordmark(FONTS.light, 'FLT-EXCHANGE', 100, { letterSpacing: 2 });
  const mark = speedMark('short-middle', word.width * 0.34);
  const pad = 22;
  const gap = 30;
  const lean = word.capHeight * TAN;

  const width = pad * 2 + word.width + lean;
  const height = pad * 2 + mark.height + gap + word.capHeight;

  write(
    'lockup/stacked.svg',
    svg({
      width,
      height,
      body:
        `<g transform="translate(${round((width - mark.width) / 2)} ${round(pad)}) ${skew}">` +
        `<path d="${mark.d}" fill="currentColor"/></g>` +
        `<g transform="translate(${round(pad + lean)} ${round(height - pad)}) ${skew}" ` +
        `fill="currentColor">${word.body}</g>`,
    }),
  );
}

/* â”€â”€ Social card, with the star field the brand already uses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

for (const variant of ['short-middle', 'accelerate']) {
  const W = 1200;
  const H = 630;
  const inner = lockup({ font: FONTS.light, text: 'FLT-EXCHANGE', variant, fill: '#fff' });

  const scale = (W * 0.66) / inner.width;
  const x = (W - inner.width * scale) / 2;
  const y = (H - inner.height * scale) / 2;

  // Deterministic, so regenerating does not reshuffle the sky.
  let seed = 20260906;
  const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  let stars = '';
  for (let i = 0; i < 110; i += 1) {
    stars +=
      `<circle cx="${round(random() * W)}" cy="${round(random() * H)}" ` +
      `r="${round(0.6 + random() * 1.7)}" fill="#fff" opacity="${round(0.2 + random() * 0.6)}"/>`;
  }

  const bodyOnly = inner.svg.replace(/^.*?role="img">/s, '').replace(/<\/svg>\s*$/, '');

  write(
    `social/og-${variant}.svg`,
    svg({
      width: W,
      height: H,
      background: '#000',
      body: `${stars}<g transform="translate(${round(x)} ${round(y)}) scale(${round(scale)})">${bodyOnly}</g>`,
    }),
  );
}

console.log('\nDone.');

