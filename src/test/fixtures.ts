import sharp from "sharp";

/** A test image with a red left half and a blue right half, so orientation shows. */
export const fixture = async (
  format: "png" | "jpeg" | "gif" | "webp",
  {
    width = 40,
    height = 20,
    orientation
  }: { width?: number; height?: number; orientation?: number } = {}
) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const left = x < width / 2;
      pixels[i] = left ? 255 : 0;
      pixels[i + 2] = left ? 0 : 255;
      pixels[i + 3] = 255;
    }
  }
  let image = sharp(pixels, { raw: { width, height, channels: 4 } });
  if (orientation) image = image.withMetadata({ orientation });
  return new Uint8Array(await image.toFormat(format).toBuffer());
};
