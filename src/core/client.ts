import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { capabilitiesFromEnvironment } from "./detect.ts";
import { MAX_ID } from "./kitty.ts";
import { acquire, createLock, release } from "./lock.ts";
import { describeSource, sourceKey } from "./source.ts";
import type {
  ImageMeta,
  ImageSource,
  Size,
  TerminalCapabilities,
  WorkerRequest,
  WorkerResponse
} from "./types.ts";

/** A worker as either Node's `worker_threads` or the web's `Worker` makes it. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  terminate?(): unknown;
  unref?(): void;
  on?(event: "message", listener: (message: unknown) => void): unknown;
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): unknown;
};

/** The stream Ink renders to: a terminal, with its descriptor and size. */
export type Output = NodeJS.WritableStream & {
  fd?: number;
  columns?: number;
  rows?: number;
};

export type ImageClientOptions = {
  /** What the terminal can do; detect it with `detectTerminal()` before rendering. */
  capabilities?: TerminalCapabilities;
  /** The stream Ink renders to. Images are written to its file descriptor. */
  stdout?: Output;
  /**
   * Starts the image worker. The default loads `worker.mjs` beside this
   * module; a bundled app (`bun build --compile`, say) builds
   * `better-ink-picture/worker` as its own entrypoint and starts that here.
   */
  worker?: () => WorkerLike;
  /** Where images without a file of their own are written. */
  tmpdir?: string;
  /** How long an image stays in the terminal after it leaves the screen, in ms. */
  releaseDelay?: number;
};

const defaultWorker = (): WorkerLike => {
  // from source in development, from the build beside it otherwise
  const url = import.meta.url.endsWith(".ts")
    ? new URL("../worker/index.ts", import.meta.url)
    : new URL("./worker.mjs", import.meta.url);
  return new Worker(url);
};

type View = {
  key: string;
  columns: number;
  rows: number;
  references: number;
  timer?: ReturnType<typeof setTimeout>;
  shown: boolean;
};

/** A small least-recently-used map. */
class Cache<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }
  override get(key: K) {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }
  override set(key: K, value: V) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.limit) this.delete(this.keys().next().value as K);
    return this;
  }
}

type Settled<T> = { promise: Promise<T>; value?: T; error?: unknown };

/**
 * The main thread's side of the image worker. It does no image work itself:
 * it hands sources to the worker, remembers what came back so a component
 * that mounts again renders at once, and counts who shows each image so it
 * leaves the terminal only once nothing does.
 */
export class ImageClient {
  readonly capabilities: TerminalCapabilities;
  private readonly stdout: Output;
  private readonly startWorker: () => WorkerLike;
  private readonly directory: string;
  private readonly releaseDelay: number;

  private worker?: WorkerLike;
  private lock?: SharedArrayBuffer;
  private restoreWrite?: () => void;
  private nextRequest = 1;
  private readonly requests = new Map<number, (response: WorkerResponse) => void>();
  private readonly probes = new Cache<string | Uint8Array, Settled<ImageMeta>>(512);
  private readonly files = new Cache<string | Uint8Array, Settled<string>>(512);
  private readonly views = new Map<number, View>();
  private readonly viewIds = new Map<string, number>();
  private readonly failures = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private nextId: number;
  private disposed = false;

  constructor({
    capabilities = capabilitiesFromEnvironment(),
    stdout = process.stdout,
    worker = defaultWorker,
    tmpdir: directory = join(tmpdir(), "better-ink-picture"),
    releaseDelay = 2000
  }: ImageClientOptions = {}) {
    this.capabilities = capabilities;
    this.stdout = stdout;
    this.startWorker = worker;
    this.directory = directory;
    this.releaseDelay = releaseDelay;
    // ids start somewhere random, so two apps in one terminal don't overwrite each other's
    this.nextId = 1 + Math.floor(Math.random() * (MAX_ID - 0x10000));
  }

  /** The worker, started on first use: an app that shows no images starts none. */
  private ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.startWorker();
    worker.unref?.();
    const onMessage = (message: unknown) => this.onMessage(message as WorkerResponse);
    if (worker.on) worker.on("message", onMessage);
    else worker.addEventListener?.("message", (event) => onMessage(event.data));

    if (this.capabilities.protocol === "kitty") {
      this.lock = createLock();
      this.guardWrites(this.lock);
    }
    this.worker = worker;
    this.post({
      type: "init",
      fd: this.stdout.fd ?? 1,
      capabilities: this.capabilities,
      maxPixels: this.maxPixels(),
      lock: this.lock,
      tmpdir: this.directory
    });
    return worker;
  }

  /** The most pixels worth decoding: the window's size, as near as it's known. */
  private maxPixels(): Size {
    const { cell, window } = this.capabilities;
    const width = window?.width ?? (this.stdout.columns || 200) * cell.width;
    const height = window?.height ?? (this.stdout.rows || 60) * cell.height;
    return { width: Math.max(width, 512), height: Math.max(height, 512) };
  }

  /** Takes the terminal lock around each of the main thread's own writes. */
  private guardWrites(buffer: SharedArrayBuffer) {
    const state = new Int32Array(buffer);
    const stdout = this.stdout;
    const original = stdout.write;
    stdout.write = function (this: Output, ...args: unknown[]) {
      acquire(state);
      try {
        return (original as (...args: unknown[]) => boolean).apply(this, args);
      } finally {
        release(state);
      }
    } as typeof stdout.write;
    this.restoreWrite = () => {
      stdout.write = original;
    };
  }

  private post(message: WorkerRequest) {
    (this.worker ?? this.ensureWorker()).postMessage(message);
  }

  private onMessage(message: WorkerResponse) {
    switch (message.type) {
      case "probe":
      case "file": {
        this.requests.get(message.req)?.(message);
        this.requests.delete(message.req);
        break;
      }
      case "shown": {
        const view = this.views.get(message.id);
        if (message.error) {
          this.failures.set(message.id, message.error);
          this.emit();
        } else if (view) view.shown = true;
        break;
      }
      case "evicted": {
        for (const [source, probe] of this.probes) {
          if (probe.value?.key === message.key) this.probes.delete(source);
        }
        break;
      }
      case "disposed": {
        this.stop();
        break;
      }
    }
  }

  private request<T extends "probe" | "file">(
    type: T,
    src: ImageSource
  ): Promise<Extract<WorkerResponse, { type: T }>> {
    const req = this.nextRequest++;
    return new Promise((resolve) => {
      this.requests.set(req, resolve as (response: WorkerResponse) => void);
      this.post({ type, req, source: describeSource(src) });
    });
  }

  private settle<T>(
    cache: Cache<string | Uint8Array, Settled<T>>,
    src: ImageSource,
    load: () => Promise<T>
  ): Settled<T> {
    const key = sourceKey(src);
    let settled = cache.get(key);
    if (!settled) {
      const entry: Settled<T> = {
        promise: load().then(
          (value) => {
            entry.value = value;
            return value;
          },
          (error) => {
            entry.error = error;
            // a failure isn't kept: the file may appear, the network may return
            setTimeout(() => cache.get(key) === entry && cache.delete(key), 5000);
            throw error;
          }
        )
      };
      entry.promise.catch(() => {});
      cache.set(key, entry);
      settled = entry;
    }
    return settled;
  }

  /**
   * An image's size and key, from the worker — once per source, however many
   * components show it. `peekProbe` has it at once when it's already known.
   */
  probe(src: ImageSource): Settled<ImageMeta> {
    return this.settle(this.probes, src, async () => {
      const response = await this.request("probe", src);
      if (!response.meta) throw new Error(response.error ?? "Could not load image");
      return response.meta;
    });
  }

  /** A file to open an image from: its own path, or a copy in the temp directory. */
  file(src: ImageSource): Settled<string> {
    return this.settle(this.files, src, async () => {
      const response = await this.request("file", src);
      if (!response.path) throw new Error(response.error ?? "Could not write image");
      return response.path;
    });
  }

  /**
   * The id an image is drawn under at a size. Each size is its own image in
   * the terminal: its placeholders are scaled to the grid it was placed on.
   */
  viewId(key: string, columns: number, rows: number): number {
    const name = `${columns}x${rows}:${key}`;
    let id = this.viewIds.get(name);
    if (id === undefined) {
      id = this.nextId;
      this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
      this.viewIds.set(name, id);
      this.views.set(id, { key, columns, rows, references: 0, shown: false });
    }
    return id;
  }

  /** Puts an image on screen (sending it, the first time) for as long as it's retained. */
  retain(id: number) {
    const view = this.views.get(id);
    if (!view || this.disposed) return;
    clearTimeout(view.timer);
    view.timer = undefined;
    view.references++;
    if (view.references === 1 && !view.shown && !this.failures.has(id)) {
      // `shown` is set when the worker confirms; until then, a second retain sends nothing
      view.shown = true;
      this.post({ type: "show", id, key: view.key, columns: view.columns, rows: view.rows });
    }
  }

  /**
   * Lets an image go. It stays a moment in case it's shown again — a
   * re-render, a resize back — and then leaves the terminal.
   */
  release(id: number) {
    const view = this.views.get(id);
    if (!view) return;
    view.references = Math.max(0, view.references - 1);
    if (view.references > 0) return;
    view.timer = setTimeout(() => {
      if (view.references > 0) return;
      this.views.delete(id);
      this.viewIds.delete(`${view.columns}x${view.rows}:${view.key}`);
      this.failures.delete(id);
      if (view.shown) this.post({ type: "release", id });
    }, this.releaseDelay);
    view.timer.unref?.();
  }

  /** Why an image couldn't be sent, if it couldn't. */
  failure(id: number): string | undefined {
    return this.failures.get(id);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  /** Removes every image this client sent from the terminal, and stops the worker. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const view of this.views.values()) clearTimeout(view.timer);
    if (!this.worker) return;
    this.post({ type: "dispose" });
    // in case the worker can't answer
    setTimeout(() => this.stop(), 1000).unref?.();
  }

  private stop() {
    this.restoreWrite?.();
    this.restoreWrite = undefined;
    this.worker?.terminate?.();
  }
}
