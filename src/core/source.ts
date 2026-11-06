import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageSource, SourceDescriptor } from "./types.ts";

const DATA_URL = /^data:([^;,]*)(;base64)?,/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** How each format's signature begins in base64. */
const BASE64_SIGNATURES = [
  "iVBORw0KGgo", // PNG
  "/9j/", // JPEG
  "R0lGOD", // GIF
  "UklGR", // RIFF (WebP)
  "Qk", // BMP
  "AAAA" // ISO BMFF (AVIF/HEIC): a box length, then `ftyp`
];

/** The shortest base64 read as an image rather than a file name. */
const MIN_BASE64_LENGTH = 64;

const expandPath = (path: string) =>
  resolve(path.startsWith("~/") || path === "~" ? homedir() + path.slice(1) : path);

/** Whether a string, after whitespace, is all base64 — one pass, no copy. */
const isBase64 = (text: string) => {
  if (text.length < MIN_BASE64_LENGTH) return false;
  // a cheap first look at the head before the full scan
  if (!BASE64.test(text.slice(0, 64).replace(/\s/g, ""))) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ok =
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      (c >= 48 && c <= 57) || // 0-9
      c === 43 || // +
      c === 47 || // /
      c === 45 || // -
      c === 95 || // _
      c === 61 || // =
      c === 10 ||
      c === 13 ||
      c === 32 ||
      c === 9;
    if (!ok) return false;
  }
  return true;
};

/**
 * What a source is, decided once on the main thread from its shape alone —
 * no file system access, so it costs nothing to call on every render.
 */
export const describeSource = (src: ImageSource): SourceDescriptor => {
  if (src instanceof Uint8Array) return { kind: "bytes", bytes: src };
  if (typeof src === "object") {
    if ("path" in src) return { kind: "path", path: expandPath(src.path) };
    if ("url" in src) return describeSource(src.url);
    if ("bytes" in src) return { kind: "bytes", bytes: src.bytes };
    return { kind: "base64", base64: src.base64 };
  }

  const data = DATA_URL.exec(src.slice(0, 256));
  if (data) {
    const body = src.slice(data[0].length);
    const mime = data[1]?.toLowerCase() || undefined;
    return data[2]
      ? { kind: "base64", base64: body, mime }
      : { kind: "bytes", bytes: Buffer.from(decodeURIComponent(body)) };
  }
  if (/^https?:\/\//i.test(src)) return { kind: "url", url: src };
  if (/^file:\/\//i.test(src)) return { kind: "path", path: fileURLToPath(src) };
  // `/` is base64 too (a JPEG's begins `/9j/`), so a string is taken as data
  // when it starts as an image does in base64, or when it has no dot and
  // doesn't start like a path; anything else is a path.
  const head = src.trimStart().slice(0, 16);
  const looksLikeImage = BASE64_SIGNATURES.some((signature) => head.startsWith(signature));
  const looksLikePath = /^(?:[/~]|\.{1,2}[/\\]|[A-Za-z]:[/\\])/.test(src) || src.includes(".");
  if ((looksLikeImage || !looksLikePath) && isBase64(src)) {
    return { kind: "base64", base64: src };
  }
  return { kind: "path", path: expandPath(src) };
};

/**
 * A key a source is cached by on the main thread. Strings and byte arrays key
 * by themselves (a Map hashes a string once and keeps it); object forms key
 * by their contents, so a fresh `{ path }` each render still hits.
 */
export const sourceKey = (src: ImageSource): string | Uint8Array => {
  if (typeof src === "string" || src instanceof Uint8Array) return src;
  if ("path" in src) return `path\0${src.path}`;
  if ("url" in src) return src.url;
  if ("bytes" in src) return src.bytes;
  return src.base64;
};
