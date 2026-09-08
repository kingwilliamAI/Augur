import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentBox, crop, decode, encode, resize, type Image } from "./png.ts";

/**
 * The codec exists to make a favicon out of whatever a designer hands over, and every way it can be
 * wrong is quiet: a mark that decodes to garbage still writes a file, a shrink that samples instead
 * of averaging still produces an image, and a trim measured wrongly still crops something.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-png-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** A lime disc on black, which is roughly what the mark is. */
function disc(w: number, h: number, r: number): Image {
  const px = Buffer.alloc(w * h * 3);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { px[i] = 0xcc; px[i + 1] = 0xff; px[i + 2] = 0; }
    }
  }
  return { w, h, ch: 3, px };
}

test("a written image reads back byte for byte", () => {
  const img = disc(64, 48, 15);
  const path = join(dir, "round.png");
  encode(path, img);
  const back = decode(path);
  assert.equal(back.w, img.w);
  assert.equal(back.h, img.h);
  assert.equal(back.ch, img.ch);
  assert.deepEqual(back.px, img.px, "pixels changed on the way through");
});

test("finds the artwork inside its empty frame", () => {
  // 40px disc centred in a 200x200 canvas: everything outside it is padding.
  const box = contentBox(disc(200, 200, 20));
  assert.ok(Math.abs(box.w - 41) <= 2, `width ${box.w}`);
  assert.ok(Math.abs(box.h - 41) <= 2, `height ${box.h}`);
  assert.ok(Math.abs(box.x - 80) <= 2, `x ${box.x}`);
});

test("an image with no empty frame is left alone", () => {
  const solid: Image = { w: 8, h: 8, ch: 3, px: Buffer.alloc(8 * 8 * 3, 0xff) };
  const box = contentBox(solid);
  assert.deepEqual(box, { x: 0, y: 0, w: 8, h: 8 });
});

test("cropping takes the region asked for", () => {
  const img = disc(40, 40, 18);
  const c = crop(img, 10, 8, 12, 14);
  assert.equal(c.w, 12);
  assert.equal(c.h, 14);
  for (let y = 0; y < 14; y++) {
    for (let x = 0; x < 12; x++) {
      const a = ((y + 8) * img.w + (x + 10)) * 3, b = (y * 12 + x) * 3;
      assert.equal(c.px[b], img.px[a], `pixel ${x},${y}`);
    }
  }
});

test("shrinking averages rather than samples", () => {
  // A one-pixel checkerboard: sampling lands on one colour or the other, averaging lands between.
  // The mark is a field of thin dots, so sampling drops most of it and the bird arrives as noise.
  const w = 64, px = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    if ((x + y) % 2 === 0) { const i = (y * w + x) * 3; px[i] = 200; px[i + 1] = 255; px[i + 2] = 100; }
  }
  const small = resize({ w, h: w, ch: 3, px }, 8, 8);
  for (let i = 0; i < small.px.length; i += 3) {
    assert.ok(small.px[i] > 60 && small.px[i] < 160, `channel came back ${small.px[i]}, not an average`);
  }
});

test("shrinking keeps the shape and survives a round trip", () => {
  const img = disc(300, 200, 80);
  const small = resize(img, 60, 40);
  assert.equal(small.w, 60);
  assert.equal(small.h, 40);
  const path = join(dir, "small.png");
  encode(path, small);
  assert.deepEqual(decode(path).px, small.px);
});

test("refuses a png it would otherwise decode wrongly", () => {
  // 16-bit is a plausible export from a design tool, and reading it as 8-bit produces an image
  // rather than an error, which is the worst outcome available.
  const path = join(dir, "deep.png");
  encode(path, disc(8, 8, 3));
  const buf = readFileSync(path);
  buf[24] = 16; // IHDR bit depth
  writeFileSync(path, buf);
  assert.throws(() => decode(path), /8-bit/);
});
