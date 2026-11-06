import { DIACRITICS } from "./diacritics.ts";
import type { Size } from "./types.ts";

/** The most rows or columns a placeholder image can number. */
export const MAX_CELLS = DIACRITICS.length;

export type FitOptions = {
  /** The image's size in pixels. */
  image: Size;
  /** One cell's size in pixels. */
  cell: Size;
  /** The most columns to take; unset leaves width to the height (or the bounds). */
  width?: number;
  /** The most rows to take; unset leaves height to the width (or the bounds). */
  height?: number;
  /** Space the image may never exceed, such as the terminal's size. */
  bounds?: Size;
  /** Whether to scale past the image's own size. */
  upscale?: boolean;
};

/**
 * The fewest whole cells that show an image at the largest size its limits
 * allow, keeping its aspect ratio:
 *
 * - with `width`, the image scales to that many columns, and its rows follow;
 * - with `height`, to that many rows, and its columns follow;
 * - with both, to the largest size that fits inside both;
 * - with neither, its own size.
 *
 * It never grows past its own pixel size (unless `upscale`), nor past
 * `bounds`, and never takes a cell more than it fills.
 */
export const fitCells = ({ image, cell, width, height, bounds, upscale = false }: FitOptions) => {
  // The image's own size, in (fractional) cells.
  const naturalColumns = image.width / cell.width;
  const naturalRows = image.height / cell.height;

  const limitColumns = Math.min(
    width ?? Number.POSITIVE_INFINITY,
    bounds?.width ?? Number.POSITIVE_INFINITY,
    MAX_CELLS
  );
  const limitRows = Math.min(
    height ?? Number.POSITIVE_INFINITY,
    bounds?.height ?? Number.POSITIVE_INFINITY,
    MAX_CELLS
  );

  let scale = Math.min(limitColumns / naturalColumns, limitRows / naturalRows);
  if (!upscale) scale = Math.min(scale, 1);
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const columns = clamp(
    Math.round(naturalColumns * scale),
    1,
    Math.max(1, Math.floor(limitColumns))
  );
  const rows = clamp(Math.round(naturalRows * scale), 1, Math.max(1, Math.floor(limitRows)));
  return { columns, rows };
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
