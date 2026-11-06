import type { ImageFormat, Size } from "./types.ts";

export type Header =
  /** The image's format and displayed size. */
  | ({ format: ImageFormat; orientation?: number } & Size)
  /** The bytes so far end before the size; read more. */
  | { format: ImageFormat; more: true }
  /** A format that has no size in a header this reads. */
  | { format: ImageFormat; unknown: true };

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** The format, from the first 12 bytes. */
export const sniffFormat = (bytes: Uint8Array): ImageFormat => {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (ascii(bytes, 0, 2) === "BM") return "bmp";
  if (ascii(bytes, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(bytes, 8, 12))) return "avif";
  const tiff = ascii(bytes, 0, 4);
  if (tiff === "II*\0" || tiff === "MM\0*") return "tiff";
  return "unknown";
};

/**
 * An image's size from its header alone — a few dozen bytes for most
 * formats, and a JPEG's markers up to its frame header — so a probe never
 * reads, let alone decodes, the whole image.
 */
export const readHeader = (bytes: Uint8Array): Header => {
  const format = sniffFormat(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (length: number) => bytes.length < length;

  switch (format) {
    case "png":
      if (need(24)) return { format, more: true };
      return { format, width: view.getUint32(16), height: view.getUint32(20) };
    case "gif":
      if (need(10)) return { format, more: true };
      return { format, width: view.getUint16(6, true), height: view.getUint16(8, true) };
    case "bmp":
      if (need(26)) return { format, more: true };
      return {
        format,
        width: Math.abs(view.getInt32(18, true)),
        height: Math.abs(view.getInt32(22, true))
      };
    case "webp":
      return readWebp(bytes, view);
    case "jpeg":
      return readJpeg(bytes, view);
    default:
      return { format, unknown: true };
  }
};

const readWebp = (bytes: Uint8Array, view: DataView): Header => {
  const format = "webp";
  if (bytes.length < 30) return { format, more: true };
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8 ") {
    return {
      format,
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    };
  }
  if (chunk === "VP8L") {
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    return {
      format,
      width: 1 + ((bytes[21] ?? 0) | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))
    };
  }
  if (chunk === "VP8X") {
    const u24 = (offset: number) =>
      (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
    return { format, width: 1 + u24(24), height: 1 + u24(27) };
  }
  return { format, unknown: true };
};

/** Start-of-frame markers, which carry a JPEG's size: all of C0–CF but DHT, JPG and DAC. */
const isFrameMarker = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const readJpeg = (bytes: Uint8Array, view: DataView): Header => {
  const format = "jpeg";
  let orientation = 1;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return { format, unknown: true };
    // fill bytes
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset];
    offset++;
    if (marker === undefined) break;
    // markers with no segment
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) continue;
    if (offset + 2 > bytes.length) break;
    const length = view.getUint16(offset);

    if (isFrameMarker(marker)) {
      if (offset + 7 > bytes.length) break;
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      // orientations 5–8 turn the image a quarter, so its sides swap
      return orientation >= 5
        ? { format, width: height, height: width, orientation }
        : { format, width, height, orientation };
    }
    if (marker === 0xe1) {
      if (offset + length > bytes.length) break;
      orientation = readExifOrientation(bytes, offset + 2, offset + length) ?? orientation;
    }
    offset += length;
  }
  return { format, more: true };
};

/** The EXIF orientation tag (1–8) from an APP1 segment, when it has one. */
const readExifOrientation = (bytes: Uint8Array, start: number, end: number) => {
  if (ascii(bytes, start, start + 6) !== "Exif\0\0") return undefined;
  const tiff = start + 6;
  if (tiff + 8 > end) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + tiff, end - tiff);
  const little = ascii(bytes, tiff, tiff + 2) === "II";
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > view.byteLength) return undefined;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return undefined;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
};
