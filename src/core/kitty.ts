import { DIACRITICS } from "./diacritics.ts";

// Kitty graphics protocol: https://sw.kovidgoyal.net/kitty/graphics-protocol/

const ESC = "\u001b";
const APC = `${ESC}_G`;
const ST = `${ESC}\\`;

/** The character a Unicode placeholder image is drawn in place of. */
export const PLACEHOLDER = "\u{10EEEE}";

/** Base64 bytes per escape code, as the protocol asks. */
export const CHUNK_SIZE = 4096;

type Controls = Record<string, string | number | undefined>;

const controls = (values: Controls) =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

export const command = (values: Controls, payload = "") =>
  `${APC}${controls(values)}${payload ? `;${payload}` : ""}${ST}`;

/** An image as the terminal is sent it, before it has an id. */
export type ImageData = {
  /** 100 for PNG, 32 for RGBA, 24 for RGB. */
  format: 100 | 32 | 24;
  /** Pixel size; needed for raw formats. */
  width?: number;
  height?: number;
  /** Whether the data is zlib-deflated. */
  compressed?: boolean;
} & (
  | { medium: "file"; path: string }
  | { medium: "direct" /** Base64 of the image's bytes. */; data: string }
);

export type Transmission = ImageData & { id: number };

/**
 * The escape codes that send an image without drawing it, quietly (`q=2`:
 * the terminal answers nothing, so no reply lands in the app's input).
 * Direct data comes out as many codes, one per chunk, so a caller can write
 * them one at a time.
 */
export const transmit = (image: Transmission): string[] => {
  const base: Controls = {
    a: "t",
    i: image.id,
    f: image.format,
    s: image.format === 100 ? undefined : image.width,
    v: image.format === 100 ? undefined : image.height,
    o: image.compressed ? "z" : undefined,
    q: 2
  };
  if (image.medium === "file") {
    return [command({ ...base, t: "f" }, Buffer.from(image.path).toString("base64"))];
  }
  const { data } = image;
  if (data.length <= CHUNK_SIZE) return [command({ ...base, t: "d" }, data)];
  const codes: string[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.slice(offset, offset + CHUNK_SIZE);
    const more = offset + CHUNK_SIZE < data.length ? 1 : 0;
    codes.push(
      offset === 0
        ? command({ ...base, t: "d", m: more }, chunk)
        : command({ m: more, q: 2 }, chunk)
    );
  }
  return codes;
};

/** A virtual placement: the cell grid the image's placeholders draw it across. */
export const place = (id: number, columns: number, rows: number) =>
  command({ a: "p", U: 1, i: id, c: columns, r: rows, C: 1, q: 2 });

/** Deletes an image and frees its data. */
export const remove = (id: number) => command({ a: "d", d: "I", i: id, q: 2 });

/**
 * The text an image is drawn in place of: a line per row, each a run of
 * placeholders colored with the image's id. The first cell of a row names
 * its row and column; the rest follow on from it.
 */
export const placeholderLines = (id: number, columns: number, rows: number): string[] => {
  const color = `${ESC}[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  const rest = PLACEHOLDER.repeat(columns - 1);
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    lines.push(`${color}${PLACEHOLDER}${DIACRITICS[row]}${DIACRITICS[0]}${rest}${ESC}[39m`);
  }
  return lines;
};

/** The largest image id placeholders can carry in a 24-bit color alone. */
export const MAX_ID = 0xffffff;
