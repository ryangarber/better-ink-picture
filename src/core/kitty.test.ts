import { renderToString, Text } from "ink";
import { createElement } from "react";
import { DIACRITICS } from "./diacritics.ts";
import { CHUNK_SIZE, PLACEHOLDER, place, placeholderLines, remove, transmit } from "./kitty.ts";

describe("transmit", () => {
  it("sends a file as its path", () => {
    const [code, ...rest] = transmit({ id: 7, format: 100, medium: "file", path: "/tmp/a.png" });
    expect(rest).toEqual([]);
    expect(code).toBe(
      `\u001b_Ga=t,i=7,f=100,q=2,t=f;${Buffer.from("/tmp/a.png").toString("base64")}\u001b\\`
    );
  });

  it("chunks direct data, naming the image only in the first", () => {
    const data = "A".repeat(CHUNK_SIZE * 2 + 10);
    const codes = transmit({
      id: 9,
      format: 32,
      width: 2,
      height: 3,
      compressed: true,
      medium: "direct",
      data
    });
    expect(codes).toHaveLength(3);
    expect(codes[0]).toMatch(/^\u001b_Ga=t,i=9,f=32,s=2,v=3,o=z,q=2,t=d,m=1;A{4096}\u001b\\$/);
    expect(codes[1]).toMatch(/^\u001b_Gm=1,q=2;A{4096}\u001b\\$/);
    expect(codes[2]).toBe("\u001b_Gm=0,q=2;AAAAAAAAAA\u001b\\");
  });

  it("places and removes quietly", () => {
    expect(place(5, 10, 4)).toBe("\u001b_Ga=p,U=1,i=5,c=10,r=4,C=1,q=2\u001b\\");
    expect(remove(5)).toBe("\u001b_Ga=d,d=I,i=5,q=2\u001b\\");
  });
});

describe("placeholderLines", () => {
  it("colors each row with the id, and numbers it in its first cell", () => {
    const id = (1 << 16) | (2 << 8) | 3;
    const lines = placeholderLines(id, 3, 2);
    expect(lines).toEqual([
      `\u001b[38;2;1;2;3m${PLACEHOLDER}${DIACRITICS[0]}${DIACRITICS[0]}${PLACEHOLDER.repeat(2)}\u001b[39m`,
      `\u001b[38;2;1;2;3m${PLACEHOLDER}${DIACRITICS[1]}${DIACRITICS[0]}${PLACEHOLDER.repeat(2)}\u001b[39m`
    ]);
  });

  it("survives Ink's layout and sanitizing intact, a cell per placeholder", () => {
    const lines = placeholderLines(0x123456, 4, 3);
    const output = renderToString(createElement(Text, { wrap: "truncate" }, lines.join("\n")), {
      columns: 4
    });
    const rows = output.split("\n");
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(row).toContain("\u001b[38;2;18;52;86m");
      expect(row).toContain(`${PLACEHOLDER}${DIACRITICS[index]}${DIACRITICS[0]}`);
      expect([...row.matchAll(new RegExp(PLACEHOLDER, "gu"))]).toHaveLength(4);
    });
  });
});
