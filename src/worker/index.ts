import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { type ImageData, place, remove, transmit } from "../core/kitty.ts";
import type { Size, WorkerRequest, WorkerResponse } from "../core/types.ts";
import { canDecode, decode } from "./decode.ts";
import { type Entry, fileFor, materialize, probe, readBytes, writeAtomic } from "./load.ts";
import { createWriter } from "./writer.ts";

/** An image ready to send, needing only an id: built once, sent at every size it's shown at. */
type Payload = ImageData;

type Config = Extract<WorkerRequest, { type: "init" }>;

// Bun and Node both give a worker `parentPort`; a web Worker without it talks over `self`.
const port = parentPort ?? (globalThis as unknown as MessagePort);
const post = (message: WorkerResponse) => port.postMessage(message);

let config: Config | undefined;
let writer: ReturnType<typeof createWriter> | undefined;
let directory = "";

/** Probed images by key, with the payload each sends as, once built; oldest first. */
const entries = new Map<string, Entry & { payload?: Promise<Payload> }>();
/** The most images kept probed: past it, the least recently used one not on screen goes. */
const MAX_ENTRIES = 128;
/** Images on screen, by id: each is one image at one size. */
const views = new Map<number, { key: string; state: "pending" | "shown" | "released" }>();

const ensureDirectory = (() => {
  let made: Promise<unknown> | undefined;
  return () => (made ??= mkdir(directory, { recursive: true }));
})();

/**
 * How an image goes to the terminal, doing as little as its format and the
 * terminal allow:
 *
 * - a PNG is never decoded — the terminal decodes it — and is sent as its
 *   path when the terminal can read our files, else as the base64 it came as;
 * - anything else is decoded once, no larger than the window, and sent as
 *   raw pixels: in a file when the terminal can read it, else deflated.
 */
const buildPayload = async (
  entry: Entry,
  maxPixels: Size,
  fileTransfer: boolean
): Promise<Payload> => {
  if (entry.meta.format === "png") {
    if (fileTransfer) {
      await ensureDirectory();
      return { format: 100, medium: "file", path: await materialize(entry, directory) };
    }
    const data = entry.base64 ?? Buffer.from(await readBytes(entry)).toString("base64");
    return { format: 100, medium: "direct", data };
  }

  const pixels = await decode(
    await readBytes(entry),
    entry.meta.format,
    entry.orientation,
    maxPixels
  );
  const { width, height } = pixels;
  // done with the encoded bytes, unless they're the only copy for a file link
  if (entry.path || entry.base64) entry.bytes = undefined;

  if (fileTransfer) {
    await ensureDirectory();
    const name = `${entry.meta.key.replace(/[^\w.-]+/g, "_").slice(-60)}-${width}x${height}.rgba`;
    const path = join(directory, name);
    await writeAtomic(path, pixels.data);
    return { format: 32, width, height, medium: "file", path };
  }
  const data = deflateSync(pixels.data, { level: 1 }).toString("base64");
  return { format: 32, width, height, compressed: true, medium: "direct", data };
};

/** Forgets the least recently used images past the limit, unless they're on screen. */
const evict = () => {
  if (entries.size <= MAX_ENTRIES) return;
  const onScreen = new Set([...views.values()].map((view) => view.key));
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    if (onScreen.has(key)) continue;
    entries.delete(key);
    post({ type: "evicted", key });
  }
};

const handlers = {
  init: async (message: Config) => {
    config = message;
    directory = message.tmpdir;
    writer = createWriter(message.fd, message.lock);
  },

  probe: async ({ req, source }: Extract<WorkerRequest, { type: "probe" }>) => {
    try {
      const entry = await probe(source);
      if (!(await canDecode(entry.meta.format))) {
        throw new Error(`No decoder for ${entry.meta.format} (install sharp to show it)`);
      }
      const existing = entries.get(entry.meta.key);
      entries.delete(entry.meta.key);
      entries.set(entry.meta.key, existing ?? entry);
      evict();
      post({ type: "probe", req, meta: entry.meta });
    } catch (error) {
      post({ type: "probe", req, error: String((error as Error)?.message ?? error) });
    }
  },

  file: async ({ req, source }: Extract<WorkerRequest, { type: "file" }>) => {
    try {
      await ensureDirectory();
      post({ type: "file", req, path: await fileFor(source, directory) });
    } catch (error) {
      post({ type: "file", req, error: String((error as Error)?.message ?? error) });
    }
  },

  show: async ({ id, key, columns, rows }: Extract<WorkerRequest, { type: "show" }>) => {
    const view = { key, state: "pending" as const };
    views.set(id, view);
    try {
      const entry = entries.get(key);
      if (!entry || !config || !writer) throw new Error("Image was not probed");
      entry.payload ??= buildPayload(entry, config.maxPixels, config.capabilities.fileTransfer);
      const payload = await entry.payload.catch((error) => {
        entry.payload = undefined;
        throw error;
      });
      // released while it was being built: never send it at all
      if (views.get(id)?.state !== "pending") return;
      views.set(id, { key, state: "shown" });
      await writer.write([...transmit({ ...payload, id }), place(id, columns, rows)]);
      post({ type: "shown", id });
    } catch (error) {
      views.delete(id);
      post({ type: "shown", id, error: String((error as Error)?.message ?? error) });
    }
  },

  release: async ({ id }: Extract<WorkerRequest, { type: "release" }>) => {
    const view = views.get(id);
    if (!view) return;
    if (view.state === "pending") {
      view.state = "released";
      views.delete(id);
      return;
    }
    views.delete(id);
    await writer?.write([remove(id)]);
  },

  dispose: async () => {
    const shown = [...views].filter(([, view]) => view.state === "shown").map(([id]) => remove(id));
    views.clear();
    await writer?.write(shown).catch(() => {});
    post({ type: "disposed" });
  }
} satisfies {
  [K in WorkerRequest["type"]]: (message: Extract<WorkerRequest, { type: K }>) => Promise<void>;
};

const onMessage = (message: WorkerRequest) => {
  (handlers[message.type] as (message: WorkerRequest) => Promise<void>)(message);
};

if (parentPort) parentPort.on("message", onMessage);
else {
  const self = globalThis as unknown as {
    addEventListener(type: "message", listener: (event: { data: WorkerRequest }) => void): void;
  };
  self.addEventListener("message", (event) => onMessage(event.data));
}
