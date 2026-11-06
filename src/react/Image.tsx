import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Box, Text, useWindowSize } from "ink";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import type { ImageClient } from "../core/client.ts";
import { placeholderLines } from "../core/kitty.ts";
import { fitCells } from "../core/layout.ts";
import { sourceKey } from "../core/source.ts";
import type { ImageMeta, ImageSource } from "../core/types.ts";
import { useImageClient } from "./ImageProvider.tsx";

/** What a fallback link points to. */
export type ImageLink = {
  /** The file the image can be opened from. */
  path: string;
  /** Its `file:` URL. */
  url: string;
  /** Whether the terminal opens OSC 8 links. */
  hyperlinks: boolean;
  alt?: string;
};

export type ImageLoad = ImageMeta & { columns: number; rows: number };

export type ImageProps = {
  /** A file path, URL, data URL, base64 string, or the image's bytes. */
  src: ImageSource;
  /**
   * The most columns to take. With only `width`, the image scales to it and
   * its rows follow; with `height` too, it fits inside both.
   */
  width?: number;
  /** The most rows to take. With only `height`, the image scales to it and its columns follow. */
  height?: number;
  /** Whether to scale an image past its own pixel size. */
  upscale?: boolean;
  /** Describes the image; the fallback link's text. */
  alt?: string;
  /** Shown while the image's size is read — usually a few milliseconds, once. */
  loading?: ReactNode;
  /** Renders the link to an image the terminal can't draw. */
  fallback?: (link: ImageLink) => ReactNode;
  onLoad?: (image: ImageLoad) => void;
  onError?: (error: Error) => void;
};

/** A value that arrives later, read at once when it's already here. */
const useSettled = <T,>(
  key: unknown,
  get: () => { promise: Promise<T>; value?: T; error?: unknown }
) => {
  const [state, setState] = useState(() => ({ key, settled: get() }));
  let { settled } = state;
  if (state.key !== key) {
    // a new source: look it up during render, so a known one shows at once
    settled = get();
    setState({ key, settled });
  }
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (settled.value !== undefined || settled.error !== undefined) return;
    let current = true;
    const update = () => current && rerender();
    settled.promise.then(update, update);
    return () => {
      current = false;
    };
  }, [settled]);
  return settled;
};

/** The latest of some callbacks, for effects that shouldn't rerun when they change. */
const useLatest = <T,>(value: T) => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
};

/**
 * An image, drawn at full resolution by a terminal that speaks the Kitty
 * graphics protocol (Kitty, Ghostty), and otherwise a link to a file of it.
 *
 * Every byte of image work happens in a worker; the component itself only
 * lays out a grid of placeholder characters, which costs no more to render
 * than a line of text.
 */
export function Image(props: ImageProps) {
  const client = useImageClient();
  if (client.capabilities.protocol === "kitty") return <KittyImage {...props} client={client} />;
  return <FileLink {...props} client={client} />;
}

function KittyImage({
  client,
  src,
  width,
  height,
  upscale,
  loading = null,
  onLoad,
  onError,
  ...rest
}: ImageProps & { client: ImageClient }) {
  const probe = useSettled(sourceKey(src), () => client.probe(src));
  const meta = probe.value;
  const { columns: windowColumns, rows: windowRows } = useWindowSize();

  const size = meta
    ? fitCells({
        image: meta,
        cell: client.capabilities.cell,
        width,
        height,
        bounds: { width: windowColumns, height: windowRows },
        upscale
      })
    : undefined;
  const columns = size?.columns;
  const rows = size?.rows;
  const id =
    meta && columns !== undefined && rows !== undefined
      ? client.viewId(meta.key, columns, rows)
      : undefined;

  useEffect(() => {
    if (id === undefined) return;
    client.retain(id);
    return () => client.release(id);
  }, [client, id]);

  const failure = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => (id === undefined ? undefined : client.failure(id))
  );
  const error = probe.error ?? failure;

  const callbacks = useLatest({ onLoad, onError });
  useEffect(() => {
    if (error)
      callbacks.current.onError?.(error instanceof Error ? error : new Error(String(error)));
  }, [error, callbacks]);
  useEffect(() => {
    if (meta && columns !== undefined && rows !== undefined && !failure) {
      callbacks.current.onLoad?.({ ...meta, columns, rows });
    }
  }, [meta, columns, rows, failure, callbacks]);

  const text = useMemo(
    () =>
      id === undefined || columns === undefined || rows === undefined
        ? ""
        : placeholderLines(id, columns, rows).join("\n"),
    [id, columns, rows]
  );

  // an image the terminal can't take — an unsupported format, say — is still a link
  if (error) return <FileLink {...rest} src={src} client={client} />;
  if (columns === undefined || rows === undefined) return <>{loading}</>;
  return (
    <Box width={columns} height={rows} flexShrink={0}>
      <Text wrap="truncate">{text}</Text>
    </Box>
  );
}

const ESC = "\u001b";
const hyperlink = (url: string, text: string) =>
  `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;

/** A file's URL, as the terminal's machine sees it. */
const fileUrl = (path: string) => {
  const url = pathToFileURL(path).href;
  // WSL inside Windows Terminal: Windows opens the link, and reaches the file through its share
  const distro = process.env.WSL_DISTRO_NAME;
  if (distro && process.env.WT_SESSION)
    return url.replace("file://", `file://wsl.localhost/${distro}`);
  return url;
};

function FileLink({
  client,
  src,
  alt,
  loading = null,
  fallback,
  onError
}: ImageProps & { client: ImageClient }) {
  const file = useSettled(sourceKey(src), () => client.file(src));
  const { hyperlinks } = client.capabilities;

  const callbacks = useLatest({ onError });
  useEffect(() => {
    if (file.error) callbacks.current.onError?.(file.error as Error);
  }, [file.error, callbacks]);

  if (file.error) return <Text dimColor>[image unavailable{alt ? `: ${alt}` : ""}]</Text>;
  if (file.value === undefined) return <>{loading}</>;

  const path = file.value;
  const url = fileUrl(path);
  if (fallback) return <>{fallback({ path, url, hyperlinks, alt })}</>;
  if (!hyperlinks) return <Text>{path}</Text>;
  return <Text>{hyperlink(url, `[image: ${alt || basename(path)}]`)}</Text>;
}
