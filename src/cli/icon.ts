import { existsSync } from "node:fs";
import { join } from "node:path";
import { contentBox, crop, decode, encode, resize } from "../png.ts";

/**
 * Trims the mark and cuts the favicons from it.
 *
 * Run this after replacing src/ui/logo.png. Two things go wrong without it, and neither is obvious
 * from looking at the file: the exported mark carries a frame of empty pixels, so it renders smaller
 * than its box and off-centre inside it, and the full-resolution mark gets served as the favicon —
 * a megabyte fetched by every visitor to draw something 32 pixels across.
 *
 * Safe to run twice. The trim is measured from the artwork each time, so a mark that is already
 * tight loses nothing.
 *
 * augur icon
 */
const UI = join(import.meta.dirname, "..", "ui");
const SOURCE = join(UI, "logo.png");

if (!existsSync(SOURCE)) {
  console.error(`no mark at ${SOURCE}; drop one in and run this again`);
  process.exit(1);
}

const img = decode(SOURCE);
const box = contentBox(img);
/** A little air, so the mark does not touch the edge of whatever box the page puts it in. */
const pad = Math.round(Math.max(box.w, box.h) * 0.02);
const x = Math.max(0, box.x - pad);
const y = Math.max(0, box.y - pad);
const w = Math.min(img.w - x, box.w + pad * 2);
const h = Math.min(img.h - y, box.h + pad * 2);

const trimmed = crop(img, x, y, w, h);
console.log(`mark ${img.w}x${img.h} -> ${w}x${h}`);
if (w < img.w || h < img.h) {
  const l = box.x, r = img.w - (box.x + box.w), t = box.y, b = img.h - (box.y + box.h);
  console.log(`  trimmed empty margins: ${l} left, ${r} right, ${t} top, ${b} bottom`);
}
encode(SOURCE, trimmed);

for (const size of [128, 64]) {
  // Fit the long side, so a mark taller than it is wide keeps its shape.
  const scale = size / Math.max(trimmed.w, trimmed.h);
  const out = resize(trimmed, Math.max(1, Math.round(trimmed.w * scale)), Math.max(1, Math.round(trimmed.h * scale)));
  const path = join(UI, `icon-${size}.png`);
  encode(path, out);
  console.log(`  icon-${size}.png  ${out.w}x${out.h}`);
}

console.log("\nthe page reads these by name; nothing else needs changing.");
