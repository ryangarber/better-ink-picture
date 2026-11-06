import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // the worker is its own entry, loaded beside the main one (`dist/worker.mjs`)
    entry: { index: "src/index.ts", worker: "src/worker/index.ts" },
    // Ink 8 is ESM-only, so this is too
    format: ["esm"],
    target: "es2024",
    platform: "node",
    sourcemap: true,
    treeshake: true,
    dts: true,
    deps: { neverBundle: ["sharp"] }
  }
]);
