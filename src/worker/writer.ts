import { writeSync } from "node:fs";
import { acquire, release, sleep } from "../core/lock.ts";

/** Chunks written before the worker yields to its own queue of messages. */
const YIELD_EVERY = 32;

/**
 * Writes escape codes straight to the terminal's file descriptor from the
 * worker, so not a byte of an image passes through the main thread. Each
 * code is written whole, under the lock the main thread's writes take too.
 */
export const createWriter = (fd: number, lockBuffer?: SharedArrayBuffer) => {
  const lock = lockBuffer ? new Int32Array(lockBuffer) : undefined;

  const writeAll = (buffer: Buffer) => {
    let offset = 0;
    while (offset < buffer.length) {
      try {
        offset += writeSync(fd, buffer, offset);
      } catch (error) {
        // a non-blocking descriptor with a full buffer: wait for the terminal
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") sleep(2);
        else throw error;
      }
    }
  };

  const writeCode = (code: string) => {
    const buffer = Buffer.from(code, "utf8");
    if (lock) acquire(lock);
    try {
      writeAll(buffer);
    } finally {
      if (lock) release(lock);
    }
  };

  let queue: Promise<void> = Promise.resolve();

  /**
   * Writes codes in order, one sequence at a time: a chunked transmission
   * must not interleave with another, but the worker still yields between
   * chunks so it can answer probes while a large image goes out.
   */
  const write = (codes: string[]) => {
    const run = async () => {
      for (let i = 0; i < codes.length; i++) {
        writeCode(codes[i] as string);
        if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise((r) => setImmediate(r));
      }
    };
    queue = queue.then(run, run);
    return queue;
  };

  return { write };
};
