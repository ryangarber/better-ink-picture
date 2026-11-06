import jpeg from "jpeg-js";
import omggif from "omggif";
import type { ImageFormat, Size } from "../core/types.ts";

export type Pixels = { data: Uint8Array; width: number; height: number };

type Sharp = (
  input: Uint8Array,
  options?: { limitInputPixels?: number | false; animated?: boolean }
) => {
  rotate(): ReturnType<Sharp>;
  resize(options: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: true;
  }): ReturnType<Sharp>;
  ensureAlpha(): ReturnType<Sharp>;
  raw(): ReturnType<Sharp>;
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
  toBuffer(options: { resolveWithObject: true }): Promise<{
    data: Buffer;
    info: { width: number; height: number; channels: number };
  }>;
};

let sharpModule: Promise<Sharp | null> | undefined;

/**
 * sharp, when the app has it: native, and far faster than the pure-JS
 * decoders, besides reading WebP, AVIF and TIFF. Its name is held in a
 * variable so bundlers leave it to runtime rather than bundle it.
 */
export const loadSharp = () => {
  const name = "sharp";
  sharpModule ??= import(/* @vite-ignore */ name).then(
    (module: { default: Sharp }) => module.default,
    () => null
  );
  return sharpModule;
};

/** Whether a format can be decoded here: PNG needs no decoding at all. */
export const canDecode = async (format: ImageFormat) =>
  format === "png" || format === "jpeg" || format === "gif" || (await loadSharp()) !== null;

/**
 * RGBA pixels of an encoded image, upright, and no larger than `max` — a
 * window can't show more, so decoding more is only memory and bytes to send.
 */
export const decode = async (
  bytes: Uint8Array,
  format: ImageFormat,
  orientation: number,
  max: Size,
  { useSharp = true }: { useSharp?: boolean } = {}
): Promise<Pixels> => {
  const sharp = useSharp ? await loadSharp() : null;
  if (sharp) {
    const { data, info } = await sharp(bytes, { limitInputPixels: false })
      .rotate()
      .resize({ width: max.width, height: max.height, fit: "inside", withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), ...info };
  }

  let pixels: Pixels;
  if (format === "jpeg") {
    const image = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: 500,
      maxMemoryUsageInMB: 4096
    });
    pixels = orient({ data: image.data, width: image.width, height: image.height }, orientation);
  } else if (format === "gif") {
    const reader = new omggif.GifReader(bytes);
    const data = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(0, data);
    pixels = { data, width: reader.width, height: reader.height };
  } else {
    throw new Error(`Unsupported image format: ${format}`);
  }
  return shrink(pixels, max);
};

/** Turns pixels upright by their EXIF orientation (1–8). */
export const orient = (pixels: Pixels, orientation: number): Pixels => {
  if (orientation <= 1 || orientation > 8) return pixels;
  const { data, width: w, height: h } = pixels;
  const swap = orientation >= 5;
  const width = swap ? h : w;
  const height = swap ? w : h;
  const out = new Uint8Array(data.length);
  // read as whole pixels, from an aligned copy when the bytes aren't aligned
  const aligned = data.byteOffset % 4 === 0 ? data : data.slice();
  const source = new Uint32Array(aligned.buffer, aligned.byteOffset, w * h);
  const target = new Uint32Array(out.buffer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2:
          [sx, sy] = [w - 1 - x, y];
          break;
        case 3:
          [sx, sy] = [w - 1 - x, h - 1 - y];
          break;
        case 4:
          [sx, sy] = [x, h - 1 - y];
          break;
        case 5:
          [sx, sy] = [y, x];
          break;
        case 6:
          [sx, sy] = [y, h - 1 - x];
          break;
        case 7:
          [sx, sy] = [w - 1 - y, h - 1 - x];
          break;
        default:
          [sx, sy] = [w - 1 - y, x];
          break; // 8
      }
      target[y * width + x] = source[sy * w + sx] as number;
    }
  }
  return { data: out, width, height };
};

/**
 * Shrinks pixels to fit inside `max`, averaging each output pixel over the
 * input pixels it covers — never enlarging.
 */
export const shrink = (pixels: Pixels, max: Size): Pixels => {
  const { data, width: w, height: h } = pixels;
  const scale = Math.min(max.width / w, max.height / h);
  if (scale >= 1) return pixels;
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(width * height * 4);
  const xRatio = w / width;
  const yRatio = h / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * w + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          // weight color by alpha, so transparent pixels don't darken edges
          const alpha = data[i + 3] as number;
          r += (data[i] as number) * alpha;
          g += (data[i + 1] as number) * alpha;
          b += (data[i + 2] as number) * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      const count = (y1 - y0) * (x1 - x0);
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / count);
    }
  }
  return { data: out, width, height };
};
