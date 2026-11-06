import { createHash } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Header, readHeader, sniffFormat } from "../core/header.ts";
import type { ImageFormat, ImageMeta, SourceDescriptor } from "../core/types.ts";
import { loadSharp } from "./decode.ts";

/** An image the worker has probed: what it is, and where its bytes are. */
export type Entry = {
  meta: ImageMeta;
  orientation: number;
  /** A file holding the image's encoded bytes: the caller's own, or a copy in the temp directory. */
  path?: string;
  /** The encoded bytes, while nothing on disk has them. */
  bytes?: Uint8Array;
  /** The base64 the image came as, sent on as it is when it's a PNG. */
  base64?: string;
};

const EXTENSIONS: Record<ImageFormat, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  avif: "avif",
  tiff: "tiff",
  unknown: "img"
};

const MIME_FORMATS: Record<string, ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/tiff": "tiff"
};

const hash = (data: string | Uint8Array) => createHash("sha1").update(data).digest("hex");

/** Writes a file whole or not at all, so the terminal never reads half of one. */
export const writeAtomic = async (path: string, data: Uint8Array) => {
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, data);
  await rename(partial, path);
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** The most of a file read for its header before reading it all. */
const MAX_HEADER = 4 * 1024 * 1024;

/** Reads a file's header, growing the read only as far as the header needs. */
const readFileHeader = async (path: string): Promise<{ header: Header; bytes?: Uint8Array }> => {
  const handle = await open(path, "r");
  try {
    let length = 64 * 1024;
    for (;;) {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const header = readHeader(bytes);
      const whole = bytesRead < length;
      if (!("more" in header) || whole) {
        return { header, bytes: whole ? bytes : undefined };
      }
      if (length >= MAX_HEADER) return { header };
      length *= 4;
    }
  } finally {
    await handle.close();
  }
};

/** The size of a header that didn't say, from sharp when the app has it. */
const sizeFromSharp = async (bytes: Uint8Array) => {
  const sharp = await loadSharp();
  if (!sharp) return undefined;
  const { width, height, orientation = 1 } = await sharp(bytes).metadata();
  if (!width || !height) return undefined;
  return orientation >= 5 ? { width: height, height: width } : { width, height };
};

const toEntry = async (
  key: string,
  header: Header,
  bytes: () => Promise<Uint8Array>,
  rest: Omit<Entry, "meta" | "orientation">
): Promise<Entry> => {
  const { format } = header;
  let size = "width" in header ? { width: header.width, height: header.height } : undefined;
  size ??= await sizeFromSharp(await bytes());
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new Error(`Could not read the size of this ${format === "unknown" ? "image" : format}`);
  }
  const orientation = "orientation" in header ? (header.orientation ?? 1) : 1;
  return { meta: { key, format, ...size }, orientation, ...rest };
};

/** The largest image fetched from a URL. */
const MAX_DOWNLOAD = 128 * 1024 * 1024;

const download = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_DOWNLOAD) throw new Error(`Image too large to fetch: ${length} bytes`);
  return new Uint8Array(await response.arrayBuffer());
};

/** Decodes the first `bytes` of a base64 string without decoding the rest. */
const decodeBase64Head = (base64: string, bytes: number) =>
  new Uint8Array(Buffer.from(base64.slice(0, Math.ceil(bytes / 3) * 4), "base64"));

/**
 * Learns an image's format and size from as little of it as it can: the
 * header of a local file (never its whole), or the head of a base64 string.
 */
export const probe = async (source: SourceDescriptor): Promise<Entry> => {
  switch (source.kind) {
    case "path": {
      const info = await stat(source.path);
      if (!info.isFile()) throw new Error(`Not a file: ${source.path}`);
      const key = `file:${source.path}:${info.mtimeMs}:${info.size}`;
      const { header, bytes } = await readFileHeader(source.path);
      return toEntry(key, header, async () => bytes ?? (await readFile(source.path)), {
        path: source.path
      });
    }
    case "url": {
      const bytes = await download(source.url);
      return toEntry(`url:${source.url}`, readHeader(bytes), async () => bytes, { bytes });
    }
    case "base64": {
      const base64 = source.base64.replace(/\s+/g, "");
      const key = `base64:${hash(base64)}`;
      let header = readHeader(decodeBase64Head(base64, 64 * 1024));
      let bytes: Uint8Array | undefined;
      const all = () => (bytes ??= new Uint8Array(Buffer.from(base64, "base64")));
      if ("more" in header) header = readHeader(all());
      return toEntry(key, header, async () => all(), { base64 });
    }
    case "bytes": {
      const bytes = source.bytes;
      return toEntry(`bytes:${hash(bytes)}`, readHeader(bytes), async () => bytes, { bytes });
    }
  }
};

/** An entry's encoded bytes, from wherever they are. */
export const readBytes = async (entry: Entry): Promise<Uint8Array> => {
  if (entry.bytes) return entry.bytes;
  if (entry.path) return new Uint8Array(await readFile(entry.path));
  if (entry.base64) return new Uint8Array(Buffer.from(entry.base64, "base64"));
  throw new Error("Image has no bytes");
};

/**
 * A file with the image's encoded bytes: the caller's own when it has one,
 * otherwise a copy in the temp directory, named by its contents so it's
 * written once however often it's asked for.
 */
export const materialize = async (entry: Entry, directory: string): Promise<string> => {
  if (entry.path) return entry.path;
  const path = join(
    directory,
    `${hash(entry.meta.key).slice(0, 20)}.${EXTENSIONS[entry.meta.format]}`
  );
  if (!(await exists(path))) await writeAtomic(path, await readBytes(entry));
  entry.path = path;
  return path;
};

/**
 * A file for a source without probing it: a path stands as itself, and
 * anything else is written to the temp directory as it came — no decoding.
 */
export const fileFor = async (source: SourceDescriptor, directory: string): Promise<string> => {
  if (source.kind === "path") {
    const info = await stat(source.path);
    if (!info.isFile()) throw new Error(`Not a file: ${source.path}`);
    return source.path;
  }
  let bytes: Uint8Array;
  let format: ImageFormat;
  let key: string;
  if (source.kind === "url") {
    bytes = await download(source.url);
    format = sniffFormat(bytes);
    key = `url:${source.url}`;
  } else if (source.kind === "base64") {
    const base64 = source.base64.replace(/\s+/g, "");
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
    format = (source.mime && MIME_FORMATS[source.mime]) || sniffFormat(bytes);
    key = `base64:${hash(base64)}`;
  } else {
    bytes = source.bytes;
    format = sniffFormat(bytes);
    key = `bytes:${hash(bytes)}`;
  }
  const path = join(directory, `${hash(key).slice(0, 20)}.${EXTENSIONS[format]}`);
  if (!(await exists(path))) await writeAtomic(path, bytes);
  return path;
};
