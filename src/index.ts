export { ImageClient, type ImageClientOptions, type WorkerLike } from "./core/client.ts";
export {
  capabilitiesFromEnvironment,
  type DetectOptions,
  detectTerminal,
  PROTOCOL_ENV,
  supportsHyperlinks
} from "./core/detect.ts";
export { type FitOptions, fitCells } from "./core/layout.ts";
export type { ImageFormat, ImageMeta, ImageSource, TerminalCapabilities } from "./core/types.ts";
export { Image, type ImageLink, type ImageLoad, type ImageProps } from "./react/Image.tsx";
export { ImageProvider, type ImageProviderProps, useImageClient } from "./react/ImageProvider.tsx";
