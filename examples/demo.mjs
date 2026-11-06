// A demo against a real terminal: `pnpm build && node examples/demo.mjs [log]`.
// Shows images from a path, bytes and base64 at a few sizes, while measuring
// how long the main thread's event loop is ever held up.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Box, render, Text } from "ink";
import { createElement as h, useEffect, useState } from "react";
import sharp from "sharp";
import { detectTerminal, Image, ImageProvider } from "../dist/index.mjs";

const log = process.argv[2];
const note = (line) => log && appendFileSync(log, `${line}\n`);

const directory = join(tmpdir(), "better-ink-picture-demo");
mkdirSync(directory, { recursive: true });

/** A gradient with a label, so scaling and orientation are visible. */
const make = (width, height, hue) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <defs><linearGradient id="g"><stop offset="0" stop-color="hsl(${hue},80%,55%)"/><stop offset="1" stop-color="hsl(${hue + 120},80%,45%)"/></linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
        <text x="50%" y="55%" font-size="${height / 4}" text-anchor="middle" fill="white" font-family="Helvetica">${width}×${height}</text>
      </svg>`
    )
  );

const pngPath = join(directory, "wide.png");
writeFileSync(pngPath, await make(1600, 600, 200).png().toBuffer());
const jpegBytes = new Uint8Array(await make(6000, 4000, 20).jpeg().toBuffer());
const webpBase64 = (await make(800, 800, 300).webp().toBuffer()).toString("base64");

const capabilities = await detectTerminal();
note(`capabilities ${JSON.stringify(capabilities)}`);

const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();

function Demo() {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    // a 60 fps animation: any freeze shows as a stall here and in the delay log
    const timer = setInterval(() => setTicks((n) => n + 1), 16);
    return () => clearInterval(timer);
  }, []);
  const loaded = (name) => (image) => note(`loaded ${name} ${JSON.stringify(image)}`);
  const failed = (name) => (error) => note(`error ${name} ${error.message}`);
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null, `protocol=${capabilities.protocol} terminal=${capabilities.terminal?.name} frame ${ticks}`),
    h(
      Box,
      { gap: 2 },
      h(Image, { src: pngPath, width: 40, alt: "wide png", onLoad: loaded("png"), onError: failed("png") }),
      h(Image, { src: { base64: webpBase64 }, height: 8, alt: "webp", onLoad: loaded("webp"), onError: failed("webp") })
    ),
    h(Image, { src: jpegBytes, width: 30, height: 6, alt: "big jpeg", onLoad: loaded("jpeg"), onError: failed("jpeg") }),
    h(Text, null, "text after the images")
  );
}

const app = render(h(ImageProvider, { capabilities }, h(Demo)));
setTimeout(() => {
  note(`event loop delay max=${(delay.max / 1e6).toFixed(1)}ms p99=${(delay.percentile(99) / 1e6).toFixed(1)}ms`);
}, 4000);
setTimeout(() => app.unmount(), Number(process.env.DEMO_MS ?? 8000));
