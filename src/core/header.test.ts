import { fixture } from "../test/fixtures.ts";
import { readHeader, sniffFormat } from "./header.ts";

describe("readHeader", () => {
  it.each(["png", "jpeg", "gif", "webp"] as const)("reads a %s's size", async (format) => {
    const bytes = await fixture(format, { width: 37, height: 23 });
    expect(sniffFormat(bytes)).toBe(format);
    expect(readHeader(bytes)).toMatchObject({ format, width: 37, height: 23 });
  });

  it("reads a lossless WebP's size", async () => {
    const sharp = (await import("sharp")).default;
    const bytes = await sharp({
      create: { width: 301, height: 129, channels: 4, background: "#f00" }
    })
      .webp({ lossless: true })
      .toBuffer();
    expect(readHeader(bytes)).toMatchObject({ format: "webp", width: 301, height: 129 });
  });

  it("swaps a JPEG's sides when EXIF turns it a quarter", async () => {
    const bytes = await fixture("jpeg", { width: 40, height: 20, orientation: 6 });
    expect(readHeader(bytes)).toMatchObject({ width: 20, height: 40, orientation: 6 });
  });

  it("asks for more when the size is past the bytes it has", async () => {
    const bytes = await fixture("jpeg", { orientation: 6 });
    expect(readHeader(bytes.subarray(0, 40))).toEqual({ format: "jpeg", more: true });
    const png = await fixture("png");
    expect(readHeader(png.subarray(0, 12))).toEqual({ format: "png", more: true });
  });

  it("knows what it can't read", () => {
    expect(readHeader(new Uint8Array([1, 2, 3, 4]))).toEqual({ format: "unknown", unknown: true });
  });
});
