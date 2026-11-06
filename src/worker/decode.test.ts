import { fixture } from "../test/fixtures.ts";
import { decode, orient, shrink } from "./decode.ts";

const MAX = { width: 4096, height: 4096 };

/** Whether the pixel at (x, y) is mostly red. */
const red = ({ data, width }: { data: Uint8Array; width: number }, x: number, y: number) => {
  const i = (y * width + x) * 4;
  return (data[i] as number) > 200 && (data[i + 2] as number) < 60;
};

describe("decode without sharp", () => {
  it("decodes a JPEG upright", async () => {
    // left half red; orientation 6 means "turn a quarter clockwise to view"
    const bytes = await fixture("jpeg", { width: 40, height: 20, orientation: 6 });
    const pixels = await decode(bytes, "jpeg", 6, MAX, { useSharp: false });
    expect(pixels).toMatchObject({ width: 20, height: 40 });
    // the red left half is now the top
    expect(red(pixels, 10, 2)).toBe(true);
    expect(red(pixels, 10, 37)).toBe(false);
  });

  it("decodes a GIF's first frame", async () => {
    const pixels = await decode(await fixture("gif"), "gif", 1, MAX, { useSharp: false });
    expect(pixels).toMatchObject({ width: 40, height: 20 });
    expect(red(pixels, 2, 10)).toBe(true);
  });

  it("shrinks to the window", async () => {
    const bytes = await fixture("jpeg", { width: 400, height: 200 });
    const pixels = await decode(bytes, "jpeg", 1, { width: 100, height: 100 }, { useSharp: false });
    expect(pixels).toMatchObject({ width: 100, height: 50 });
    expect(pixels.data.length).toBe(100 * 50 * 4);
  });

  it("leaves what it can't decode to sharp", async () => {
    await expect(
      decode(await fixture("webp"), "webp", 1, MAX, { useSharp: false })
    ).rejects.toThrow(/Unsupported/);
  });
});

describe("decode with sharp", () => {
  it("decodes WebP, upright and shrunk", async () => {
    const pixels = await decode(await fixture("webp", { width: 400, height: 200 }), "webp", 1, {
      width: 200,
      height: 200
    });
    expect(pixels).toMatchObject({ width: 200, height: 100 });
  });
});

describe("orient", () => {
  // a 2×1 image: A then B
  const A = [1, 1, 1, 1];
  const B = [2, 2, 2, 2];
  const pixels = { data: new Uint8Array([...A, ...B]), width: 2, height: 1 };

  it.each([
    [2, 2, 1, [...B, ...A]],
    [3, 2, 1, [...B, ...A]],
    [6, 1, 2, [...A, ...B]],
    [8, 1, 2, [...B, ...A]]
  ])("orientation %i", (orientation, width, height, data) => {
    expect(orient(pixels, orientation)).toEqual({ data: new Uint8Array(data), width, height });
  });
});

describe("shrink", () => {
  it("averages, weighting color by alpha", () => {
    // an opaque red pixel beside a transparent black one: red stays red
    const pixels = { data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]), width: 2, height: 1 };
    expect(shrink(pixels, { width: 1, height: 1 })).toEqual({
      data: new Uint8Array([255, 0, 0, 128]),
      width: 1,
      height: 1
    });
  });

  it("never enlarges", () => {
    const pixels = { data: new Uint8Array(4), width: 1, height: 1 };
    expect(shrink(pixels, { width: 10, height: 10 })).toBe(pixels);
  });
});
