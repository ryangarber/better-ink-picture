/**
 * A lock over the terminal, shared by the main thread and the worker, so an
 * escape code the worker writes never lands in the middle of one of Ink's
 * frames (or the reverse): a write to a terminal can block partway when its
 * buffer fills, and on macOS another writer can get in while it does.
 *
 * Each side holds it for one write — a frame, or one 4 KB chunk of an image —
 * so neither waits on the other for long.
 */
export const createLock = () => new SharedArrayBuffer(4);

const FREE = 0;
const HELD = 1;

const wait = (state: Int32Array, timeout: number) => {
  try {
    Atomics.wait(state, 0, HELD, timeout);
  } catch {
    // a thread that may not block (a browser's main thread) spins instead
  }
};

export const acquire = (state: Int32Array) => {
  while (Atomics.compareExchange(state, 0, FREE, HELD) !== FREE) wait(state, 10);
};

export const release = (state: Int32Array) => {
  Atomics.store(state, 0, FREE);
  Atomics.notify(state, 0, 1);
};

/** Sleeps the current thread. */
export const sleep = (ms: number) => {
  wait(new Int32Array(new SharedArrayBuffer(4)), ms);
};
