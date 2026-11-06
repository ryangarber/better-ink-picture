# better-ink-picture

Images for [Ink](https://github.com/vadimdemedes/ink) that never block the render loop.

- **Off the main thread.** Reading, probing, decoding and sending images all happen in a worker, which writes
  straight to the terminal's file descriptor. The main thread only lays out a grid of placeholder characters.
- **Fast paths only.** Kitty graphics with Unicode placeholders (Kitty ≥ 0.28, Ghostty): the terminal draws the image
  at full resolution, and it scrolls, clips and re-renders like text. Every other terminal gets a link to a file.
- **Detection that asks.** The terminal is queried for graphics support, whether it can read our files, its cell size
  and its name, with no fixed sleeps.
- **Little work.** PNGs are never decoded. A local PNG is sent as its path, and base64 is sent as it came. Other formats
  are decoded once, never larger than the window. Probes read headers only.
- **Smart scaling.** Give a width, a height, or both: the image keeps its aspect ratio and takes only the cells it
  fills, never more than its own size or the terminal's.

## Usage

```tsx
import { render } from "ink";
import { detectTerminal, Image, ImageProvider } from "better-ink-picture";

// before render(): detection reads stdin, which Ink takes over
const capabilities = await detectTerminal();

render(
  <ImageProvider capabilities={capabilities}>
    <Image src="./photo.jpg" width={40} alt="a photo" />
  </ImageProvider>
);
```

`src` takes a file path, `http(s):`/`file:` URL, data URL, base64 string, `Uint8Array`, or an explicit
`{ path } | { url } | { base64 } | { bytes }`.

| Prop       | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `width`    | Most columns; alone, the image scales to it and its rows follow                |
| `height`   | Most rows; alone, the image scales to it and its columns follow                |
| `upscale`  | Allow scaling past the image's own pixel size (default `false`)                |
| `alt`      | Description; the fallback link's text                                          |
| `loading`  | Shown while the header is read                                                 |
| `fallback` | `({ path, url, hyperlinks, alt }) => ReactNode` for terminals without graphics |
| `onLoad`   | Called with the image's size in pixels and cells                               |
| `onError`  | Called when the image can't be read                                            |

Without graphics, an image is written to `$TMPDIR/better-ink-picture` (a local file links to itself). The link is OSC 8
where the terminal supports it, and the plain path otherwise.

`BETTER_INK_PICTURE_PROTOCOL=kitty|none` forces the protocol. Install `sharp` to decode WebP, AVIF and TIFF, and to
decode JPEG and GIF faster. Without it, JPEG and GIF use pure-JS decoders, and other formats fall back to a link.

## Bundlers

By default the worker loads from `worker.mjs` beside the main module. A bundled app, such as
`bun build --compile`, should build `better-ink-picture/worker` as its own entrypoint and start it:

```ts
<ImageProvider capabilities={capabilities} worker={() => new Worker(new URL("./image-worker.js", import.meta.url))}>
```

## Limits

- Inside tmux or screen, images fall back to links.
- GIFs show their first frame.
- An image is at most 297×297 cells, the size of the protocol's placeholder table.
