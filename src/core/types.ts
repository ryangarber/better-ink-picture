/**
 * An image to show:
 * - a file path (absolute, relative to the working directory, or `~/`-prefixed)
 * - an `http(s):` or `file:` URL
 * - a `data:` URL, or a bare base64 string
 * - the encoded bytes themselves
 * - any of the above stated explicitly, when a string could be read more than one way
 */
export type ImageSource =
  | string
  | Uint8Array
  | { path: string }
  | { url: string }
  | { base64: string }
  | { bytes: Uint8Array };

/** A source as the worker receives it: classified, with nothing left to guess. */
export type SourceDescriptor =
  | { kind: "path"; path: string }
  | { kind: "url"; url: string }
  | { kind: "base64"; base64: string; mime?: string }
  | { kind: "bytes"; bytes: Uint8Array };

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "tiff" | "unknown";

/** What a probe learns about an image, from as few of its bytes as it can. */
export type ImageMeta = {
  /** Identifies the image's contents across sources and renders. */
  key: string;
  /** Pixel width, as displayed (after EXIF orientation). */
  width: number;
  /** Pixel height, as displayed (after EXIF orientation). */
  height: number;
  format: ImageFormat;
};

export type Size = { width: number; height: number };

export type TerminalCapabilities = {
  /**
   * How images are drawn: `kitty` is the Kitty graphics protocol with Unicode
   * placeholders (Kitty ≥ 0.28, Ghostty); `none` stands an image as a link to
   * a file instead.
   */
  protocol: "kitty" | "none";
  /**
   * Whether the terminal can read files this process writes, so an image is
   * sent as its path rather than its bytes (false over SSH, for one).
   */
  fileTransfer: boolean;
  /** Whether the terminal opens OSC 8 hyperlinks. */
  hyperlinks: boolean;
  /** One cell's size in pixels. */
  cell: Size;
  /** The window's size in pixels, when the terminal reported it. */
  window?: Size;
  /** The terminal's own name and version, from XTVERSION. */
  terminal?: { name: string; version?: string };
  /** How the capabilities were found. */
  detectedBy: "query" | "environment" | "override";
};

/** Main thread → worker. */
export type WorkerRequest =
  | {
      type: "init";
      fd: number;
      capabilities: TerminalCapabilities;
      /** The cap on decoded pixels: there is no use sending more than a window can show. */
      maxPixels: Size;
      /** A lock shared with the main thread's writes, so escape codes never interleave. */
      lock?: SharedArrayBuffer;
      tmpdir: string;
    }
  | { type: "probe"; req: number; source: SourceDescriptor }
  | { type: "file"; req: number; source: SourceDescriptor }
  | { type: "show"; id: number; key: string; columns: number; rows: number }
  | { type: "release"; id: number }
  | { type: "dispose" };

/** Worker → main thread. */
export type WorkerResponse =
  | { type: "probe"; req: number; meta?: ImageMeta; error?: string }
  | { type: "file"; req: number; path?: string; error?: string }
  | { type: "shown"; id: number; error?: string }
  /** The worker forgot an image; probe it again before showing it. */
  | { type: "evicted"; key: string }
  | { type: "disposed" };
