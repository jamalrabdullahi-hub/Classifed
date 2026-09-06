import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

/**
 * Brand asset generator for FLT-Exchange.
 *
 * Renders the wordmark from Arkitech into outlined SVG paths, pairs it with the
 * three-bar speed mark, and rasterises the icons browsers still want as PNG.
 * Outlines rather than live text deliberately: a logo has to render identically
 * everywhere without shipping the font, and Arkitech is licensed to FLT rather
 * than to whoever loads the page.
 *
 * The font is NOT committed. Point FONT_DIR at the licensed copy:
 *   node brand/generate.mjs
 *
 * Two opentype.js 2.0 defects shape the code below, both of which fail by
 * silently emitting NaN coordinates so letters vanish rather than erroring:
 * Path.extend() and the font-level getPath/getPaths helpers corrupt merged
 * glyphs, and glyph.getPath() corrupts glyphs given a non-zero x or when the
 * commands it returns are mutated. Rendering each glyph at the origin and
 * positioning it with a transform is the only reliable arrangement.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'assets');
const FONT_DIR = process.env.FONT_DIR ?? 'C:/FLT-Pay/media & logos/arktech-2/arkitech-2-font';

const loadFont = (file) => opentype.parse(readFileSync(join(FONT_DIR, file)).buffer);
const FONTS = { light: loadFont('ArkitechLight-ovWKz.otf'), medium: loadFont('ArkitechMedium-R9EYv.otf') };

/** The chosen mark. Every other reading is one line away if it is revisited. */
const CANONICAL = 'stagger';

/** Bar lengths top to bottom, as a fraction of the mark's width. */
const MARKS = {
  equal: [1, 1, 1],
  'short-middle': [1, 0.6, 1],
  accelerate: [0.5, 0.75, 1],
  decelerate: [1, 0.75, 0.5],
  stagger: [1, 0.45, 0.8],
};

/** Degrees of lean, matching the FTL-Pay wordmark. */
const SLANT = 12;
const TAN = Math.tan((SLANT * Math.PI) / 180);

const round = (n) => Number(n.toFixed(2));
/** Leans the top of a shape right; y grows downward in SVG. */
const skew = `skewX(${-SLANT})`;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outlines for a string on a baseline at y = 0, as positioned <path> elements.
 * Geometry is upright; callers apply the shear via transform.
 */
function wordmark(font, text, size, { letterSpacing = 0, precision = 2 } = {}) {
  const scale = size / font.unitsPerEm;
  const glyphs = [];
  let x = 0;
  let capHeight = 0;
  let width = 0;

  for (const glyph of font.stringToGlyphs(text)) {
    const path = glyph.getPath(0, 0, size);
    const d = path.toPathData(precision);

    // Guard rather than trust: a malformed glyph must not drop a letter out of
    // the wordmark without saying so.
    if (d && !d.includes('NaN')) {
      glyphs.push({ x: round(x), d });
      const box = path.getBoundingBox();
      if (Number.isFinite(box.y1)) capHeight = Math.max(capHeight, Math.abs(box.y1));
      if (Number.isFinite(box.x2)) width = Math.max(width, x + box.x2);
    } else {
      throw new Error(`Malformed glyph "${glyph.name}" in "${text}"`);
    }

    x += glyph.advanceWidth * scale + letterSpacing;
  }

  const body = glyphs.map((g) => `<path transform="translate(${g.x} 0)" d="${g.d}"/>`).join('');
  return { body, glyphs, width, capHeight };
}

/** Bars as axis-aligned rects; callers skew them to match the letters. */
function speedMark(variant, unit, { weight = 0.17, gap = 0.145 } = {}) {
  const bar = unit * weight;
  const gapH = unit * gap;
  const d = (MARKS[variant] ?? MARKS.equal)
    .map((length, index) => {
      const y = index * (bar + gapH);
      return `M0 ${round(y)}h${round(unit * length)}v${round(bar)}h${round(-unit * length)}z`;
    })
    .join('');
  return { d, width: unit, height: bar * 3 + gapH * 2 };
}

function svg({ width, height, body, background }) {
  const bg = background ? `<rect width="${round(width)}" height="${round(height)}" fill="${background}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" ` +
    `width="${round(width)}" height="${round(height)}" fill="none" role="img">${bg}${body}</svg>\n`
  );
}

const written = [];
function write(name, contents) {
  const target = join(OUT, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, typeof contents === 'string' ? 'utf8' : undefined);
  written.push(name);
}

/** A square containing the mark alone, padded and centred. */
function markSquare({ fill = 'currentColor', background, unit = 100, pad = 0.2, radius = 0, options = {} } = {}) {
  const mark = speedMark(CANONICAL, unit, options);
  const lean = mark.height * TAN;
  const padPx = unit * pad;
  const box = Math.max(unit + lean, mark.height) + padPx * 2;

  const bg = background
    ? `<rect width="${round(box)}" height="${round(box)}" rx="${round(box * radius)}" fill="${background}"/>`
    : '';

  const body =
    bg +
    `<g transform="translate(${round((box - unit - lean) / 2 + lean)} ${round((box - mark.height) / 2)}) ${skew}">` +
    `<path d="${mark.d}" fill="${fill}"/></g>`;

  return { markup: svg({ width: box, height: box, body }), box };
}

/** Horizontal lockup: mark, gap, wordmark. */
function lockup({ font, text, size = 100, fill = 'currentColor', background }) {
  const word = wordmark(font, text, size, { letterSpacing: size * 0.02 });
  const mark = speedMark(CANONICAL, word.capHeight * 1.45);
  const scale = word.capHeight / mark.height;
  const markW = mark.width * scale;

  const gap = size * 0.3;
  const pad = size * 0.18;
  const lean = word.capHeight * TAN;

  const width = pad * 2 + markW + gap + word.width + lean;
  const height = pad * 2 + word.capHeight;

  const body =
    `<g transform="translate(${round(pad + lean)} ${round(pad)}) ${skew}">` +
    `<g transform="scale(${round(scale)})"><path d="${mark.d}" fill="${fill}"/></g></g>` +
    `<g transform="translate(${round(pad + lean + markW + gap)} ${round(pad + word.capHeight)}) ${skew}" ` +
    `fill="${fill}">${word.body}</g>`;

  return { markup: svg({ width, height, body, background }), width, height, body, word, markW, mark, scale };
}

// ─────────────────────────────────────────────────────────────────────────────

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
console.log(`Generating FLT-Exchange assets — mark: ${CANONICAL}\n`);

/* ── Favicon ──────────────────────────────────────────────────────────────── */

// For embedding in a document, where it inherits colour from its context.
write('favicon/favicon.svg', markSquare().markup);

/*
 * The browser-tab favicon.
 *
 * Drawn separately rather than scaled down from the file above: at 16px the
 * standard bar weight lands under three pixels and greys out, so the bars are
 * thickened and the gaps opened. Since browsers prefer an SVG icon at every
 * size, this tuned drawing is the one the application ships.
 *
 * The fill is explicit and theme-aware. A favicon has no inherited colour, so
 * currentColor resolves to black and the mark disappears against a dark tab
 * strip.
 */
{
  const tuned = markSquare({ fill: 'var(--fg)', pad: 0.12, options: { weight: 0.235, gap: 0.16 } });
  const style =
    `<style>:root{--fg:#0a0b0d}` +
    `@media (prefers-color-scheme:dark){:root{--fg:#ffffff}}</style>`;
  write('favicon/favicon-16.svg', tuned.markup.replace('role="img">', `role="img">${style}`));
}

/* ── App icons ────────────────────────────────────────────────────────────── */

const appIcon = markSquare({ fill: '#fff', background: '#000', radius: 0.22 });
write('icon/app.svg', appIcon.markup);

// Android crops maskable icons to a circle, so the mark is inset further.
const maskable = markSquare({ fill: '#fff', background: '#000', pad: 0.42 });
write('icon/maskable.svg', maskable.markup);

/* ── Lockups ──────────────────────────────────────────────────────────────── */

write('lockup/primary.svg', lockup({ font: FONTS.light, text: 'FLT-EXCHANGE' }).markup);
write('lockup/primary-medium.svg', lockup({ font: FONTS.medium, text: 'FLT-EXCHANGE' }).markup);
write('lockup/short.svg', lockup({ font: FONTS.light, text: 'FLT' }).markup);

{
  const word = wordmark(FONTS.light, 'FLT-EXCHANGE', 100, { letterSpacing: 2 });
  const mark = speedMark(CANONICAL, word.width * 0.34);
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

/* ── Wordmarks alone ──────────────────────────────────────────────────────── */

for (const [name, font, text] of [
  ['flt-exchange', FONTS.light, 'FLT-EXCHANGE'],
  ['flt-exchange-medium', FONTS.medium, 'FLT-EXCHANGE'],
  ['flt', FONTS.light, 'FLT'],
]) {
  const word = wordmark(font, text, 100, { letterSpacing: 2 });
  const pad = 18;
  const lean = word.capHeight * TAN;
  write(
    `wordmark/${name}.svg`,
    svg({
      width: pad * 2 + word.width + lean,
      height: pad * 2 + word.capHeight,
      body:
        `<g transform="translate(${round(pad + lean)} ${round(pad + word.capHeight)}) ${skew}" ` +
        `fill="currentColor">${word.body}</g>`,
    }),
  );
}

/* ── Social card ──────────────────────────────────────────────────────────── */

const OG_W = 1200;
const OG_H = 630;
{
  const inner = lockup({ font: FONTS.light, text: 'FLT-EXCHANGE', fill: '#fff' });
  const scale = (OG_W * 0.66) / inner.width;

  // Deterministic, so regenerating does not reshuffle the sky.
  let seed = 20260906;
  const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  let stars = '';
  for (let i = 0; i < 110; i += 1) {
    stars +=
      `<circle cx="${round(random() * OG_W)}" cy="${round(random() * OG_H)}" ` +
      `r="${round(0.6 + random() * 1.7)}" fill="#fff" opacity="${round(0.2 + random() * 0.6)}"/>`;
  }

  write(
    'social/og.svg',
    svg({
      width: OG_W,
      height: OG_H,
      background: '#000',
      body:
        stars +
        `<g transform="translate(${round((OG_W - inner.width * scale) / 2)} ` +
        `${round((OG_H - inner.height * scale) / 2)}) scale(${round(scale)})">${inner.body}</g>`,
    }),
  );
}

/* ── Rasters ──────────────────────────────────────────────────────────────── */

/*
 * Browsers that will not take an SVG icon: Safari wants apple-touch-icon.png,
 * Android wants the manifest PNGs, and older Windows still asks for favicon.ico.
 * Rendered from the explicit-colour SVGs, since currentColor has nothing to
 * resolve against outside a document.
 */
console.log('\nRasterising...');

const render = (markup, size) =>
  sharp(Buffer.from(markup)).resize(size, size, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer();

// Tab icons: white bars on black, so they read on either browser chrome.
const tabIcon = (opts) => markSquare({ fill: '#fff', background: '#000', ...opts }).markup;

const png16 = await render(tabIcon({ pad: 0.12, options: { weight: 0.235, gap: 0.16 } }), 16);
const png32 = await render(tabIcon({ pad: 0.16, options: { weight: 0.2, gap: 0.15 } }), 32);
const png48 = await render(tabIcon(), 48);

write('favicon/favicon-16.png', png16);
write('favicon/favicon-32.png', png32);
write('favicon/favicon-48.png', png48);
write('favicon/favicon.ico', await pngToIco([png16, png32, png48]));

write('icon/apple-touch-icon.png', await render(appIcon.markup, 180));
write('icon/icon-192.png', await render(appIcon.markup, 192));
write('icon/icon-512.png', await render(appIcon.markup, 512));
write('icon/maskable-512.png', await render(maskable.markup, 512));

write(
  'social/og.png',
  await sharp(Buffer.from(readFileSync(join(OUT, 'social/og.svg'), 'utf8')))
    .resize(OG_W, OG_H)
    .png({ compressionLevel: 9 })
    .toBuffer(),
);

/* ── Generated React art ──────────────────────────────────────────────────── */

/*
 * The mark and wordmark are emitted as a component so the application cannot
 * drift from the asset files. Regenerating updates both.
 */
{
  const mark = speedMark(CANONICAL, 100);
  const markLean = mark.height * TAN;
  const markBox = Math.max(100 + markLean, mark.height);

  const word = wordmark(FONTS.light, 'FLT-EXCHANGE', 100, { letterSpacing: 2, precision: 1 });
  const wordLean = word.capHeight * TAN;

  const short = wordmark(FONTS.light, 'FLT', 100, { letterSpacing: 2, precision: 1 });
  const shortLean = short.capHeight * TAN;

  const tsx = `/*
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by brand/generate.mjs from the licensed Arkitech typeface. The
 * outlines live here rather than in a font file so the interface renders the
 * real wordmark without shipping a licensed font to every visitor.
 *
 * Regenerate with: node brand/generate.mjs
 */

export const BRAND_MARK = {
  viewBox: '0 0 ${round(markBox)} ${round(mark.height)}',
  transform: 'translate(${round(markLean)} 0) ${skew}',
  d: '${mark.d}',
} as const;

export const BRAND_WORDMARK = {
  viewBox: '0 0 ${round(word.width + wordLean)} ${round(word.capHeight)}',
  transform: 'translate(${round(wordLean)} ${round(word.capHeight)}) ${skew}',
  glyphs: ${JSON.stringify(word.glyphs)},
} as const;

export const BRAND_WORDMARK_SHORT = {
  viewBox: '0 0 ${round(short.width + shortLean)} ${round(short.capHeight)}',
  transform: 'translate(${round(shortLean)} ${round(short.capHeight)}) ${skew}',
  glyphs: ${JSON.stringify(short.glyphs)},
} as const;
`;

  const target = join(HERE, '..', 'packages', 'ui', 'src', 'brand-art.ts');
  writeFileSync(target, tsx, 'utf8');
  console.log('   packages/ui/src/brand-art.ts');
}

console.log(`\n${written.length} asset files written to brand/assets.`);
for (const name of written) console.log('  ', name);
