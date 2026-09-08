import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

/**
 * Just enough PNG to trim and shrink the project mark.
 *
 * Written out rather than pulled in for the same reason the booster is: the tool stays one runtime
 * with one dependency, and a designer replacing a logo should not have to install an image library
 * to get a favicon out of it. Only what that job needs is here — 8-bit, non-interlaced, no palette —
 * and anything else is refused loudly rather than decoded wrongly.
 *
 * The shrink is a box average, not a nearest-neighbour pick. The mark is a field of thin dots, and
 * sampling one pixel per output cell drops most of them: the bird arrives at 64px as sparse noise.
 */

export type Image = { w: number; h: number; ch: number; px: Buffer };

export function decode(path: string): Image {
  const buf = readFileSync(path);
  let off = 8;
  const idat: Buffer[] = [];
  let hdr: { w: number; h: number; depth: number; colour: number; interlace: number } | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") hdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (!hdr) throw new Error(`${path}: no IHDR`);
  const CH = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[hdr.colour];
  if (hdr.depth !== 8 || hdr.interlace !== 0 || !CH) {
    throw new Error(`${path}: need an 8-bit non-interlaced png, got depth ${hdr.depth} colour ${hdr.colour}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = hdr.w * CH, px = Buffer.alloc(hdr.h * stride);
  let p = 0;
  for (let y = 0; y < hdr.h; y++) {
    const f = raw[p++], line = raw.subarray(p, p + stride); p += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0, b = prev[i], c = i >= CH ? prev[i - CH] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w: hdr.w, h: hdr.h, ch: CH, px };
}

const crc = (b: Buffer): number => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out;
};

/** Filter 0 on every scanline: the image is flat colour, so the encoder's job is deflate's anyway. */
export function encode(path: string, { w, h, ch, px }: Image): void {
  const stride = w * ch, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as Record<number, number>)[ch];
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}

export function crop(img: Image, x0: number, y0: number, w: number, h: number): Image {
  const out = Buffer.alloc(w * h * img.ch);
  for (let y = 0; y < h; y++) {
    img.px.copy(out, y * w * img.ch, ((y0 + y) * img.w + x0) * img.ch, ((y0 + y) * img.w + x0 + w) * img.ch);
  }
  return { w, h, ch: img.ch, px: out };
}

/** Box average, because a mark of thin dots aliases into nothing under nearest-neighbour. */
export function resize(img: Image, W: number, H: number): Image {
  const out = Buffer.alloc(W * H * img.ch);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.floor(x * img.w / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.w / W));
    const y0 = Math.floor(y * img.h / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.h / H));
    for (let c = 0; c < img.ch; c++) {
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += img.px[(yy * img.w + xx) * img.ch + c]; n++; }
      out[(y * W + x) * img.ch + c] = Math.round(sum / n);
    }
  }
  return { w: W, h: H, ch: img.ch, px: out };
}

/**
 * The box the visible artwork actually occupies.
 *
 * A mark exported from a design tool usually carries a frame of empty pixels, and that frame is
 * spent twice over: it shrinks the artwork inside whatever box the page gives it, and it is rarely
 * even, so the mark also sits off-centre. Trimming it is the cheapest size the mark will ever gain.
 */
export function contentBox(img: Image, threshold = 24): { x: number; y: number; w: number; h: number } {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.ch;
      const alpha = img.ch === 4 || img.ch === 2 ? img.px[i + img.ch - 1] : 255;
      const lum = img.ch >= 3 ? (img.px[i] + img.px[i + 1] + img.px[i + 2]) / 3 : img.px[i];
      if (alpha > 20 && lum > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: img.w, h: img.h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
