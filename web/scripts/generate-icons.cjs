#!/usr/bin/env node
/**
 * Generates PNG app icons for the COACH PWA from the existing SVG favicon design:
 * a blue (#2563eb) rounded-rectangle background with the "督" glyph in white.
 *
 * Outputs:
 *   web/public/icon-192.png          — standard 192×192 icon
 *   web/public/icon-512.png          — standard 512×512 icon
 *   web/public/icon-maskable-512.png — maskable 512×512 (glyph in safe zone)
 *   web/public/apple-touch-icon.png  — 180×180 for iOS home screen
 *
 * Run once after cloning, or after changing the icon design:
 *   node scripts/generate-icons.js
 */

const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public');

// WenQuanYi Zen Hei is present in the container; any CJK-capable system font works.
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/unifont/unifont.otf',
];
for (const f of FONT_CANDIDATES) {
  if (fs.existsSync(f)) { registerFont(f, { family: 'IconFont' }); break; }
}

const BLUE  = '#2563eb';
const WHITE = '#ffffff';
const GLYPH = '督';

/**
 * Draws the icon onto a canvas of the given size.
 * @param {number} size        — canvas width/height in px
 * @param {number} radiusFrac  — corner radius as a fraction of size
 * @param {number} fontFrac    — font-size as a fraction of size
 * @param {number} yOffsetFrac — vertical offset of glyph centre from canvas centre (fraction of size)
 */
function drawIcon(size, radiusFrac = 0.125, fontFrac = 0.5625, yOffsetFrac = 0.05) {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const r      = Math.round(size * radiusFrac);
  const half   = size / 2;

  // Blue rounded-rect background
  ctx.fillStyle = BLUE;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // White "督" glyph
  ctx.fillStyle = WHITE;
  ctx.font = `bold ${Math.round(size * fontFrac)}px IconFont, 'WenQuanYi Zen Hei', sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(GLYPH, half, half + Math.round(size * yOffsetFrac));

  return canvas;
}

/**
 * Maskable icon: the "safe zone" for maskable icons is the central 80% circle.
 * We scale the glyph down so it fits comfortably inside that zone.
 */
function drawMaskableIcon(size) {
  return drawIcon(size, 0, 0.4, 0.04); // no corner radius (fill full square), smaller glyph
}

const icons = [
  { file: 'icon-192.png',          canvas: drawIcon(192)          },
  { file: 'icon-512.png',          canvas: drawIcon(512)          },
  { file: 'icon-maskable-512.png', canvas: drawMaskableIcon(512)  },
  { file: 'apple-touch-icon.png',  canvas: drawIcon(180)          },
];

for (const { file, canvas } of icons) {
  const dest = path.join(OUT_DIR, file);
  fs.writeFileSync(dest, canvas.toBuffer('image/png'));
  console.log(`  wrote ${dest}  (${canvas.width}×${canvas.height})`);
}

console.log('Icons generated successfully.');
