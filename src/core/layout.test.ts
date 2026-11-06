import { fitCells, MAX_CELLS } from "./layout.ts";

const cell = { width: 10, height: 20 };

describe("fitCells", () => {
  // 800×400 px is 80×20 cells at its own size
  const image = { width: 800, height: 400 };

  it("takes the image's own size when nothing limits it", () => {
    expect(fitCells({ image, cell })).toEqual({ columns: 80, rows: 20 });
  });

  it("scales to a width, with rows following", () => {
    expect(fitCells({ image, cell, width: 40 })).toEqual({ columns: 40, rows: 10 });
  });

  it("scales to a height, with columns following", () => {
    expect(fitCells({ image, cell, height: 5 })).toEqual({ columns: 20, rows: 5 });
  });

  it("fits inside both, taking no more than it fills", () => {
    // 40 wide would be 10 tall, past 6; 6 tall is 24 wide
    expect(fitCells({ image, cell, width: 40, height: 6 })).toEqual({ columns: 24, rows: 6 });
    // a tall box: the width decides, and the box's spare rows aren't taken
    expect(fitCells({ image, cell, width: 40, height: 100 })).toEqual({ columns: 40, rows: 10 });
  });

  it("never grows past its own size unless asked", () => {
    expect(fitCells({ image, cell, width: 200 })).toEqual({ columns: 80, rows: 20 });
    expect(fitCells({ image, cell, width: 160, upscale: true })).toEqual({
      columns: 160,
      rows: 40
    });
  });

  it("never passes its bounds", () => {
    expect(fitCells({ image, cell, width: 80, bounds: { width: 100, height: 8 } })).toEqual({
      columns: 32,
      rows: 8
    });
  });

  it("takes at least one cell, and at most what placeholders can number", () => {
    expect(fitCells({ image: { width: 1, height: 1 }, cell })).toEqual({ columns: 1, rows: 1 });
    const huge = fitCells({ image: { width: 100_000, height: 100 }, cell });
    expect(huge.columns).toBe(MAX_CELLS);
  });
});
