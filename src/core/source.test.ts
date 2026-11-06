import { homedir } from "node:os";
import { resolve } from "node:path";
import { describeSource, sourceKey } from "./source.ts";

const PNG_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`;
const JPEG_BASE64 = `/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL`;

describe("describeSource", () => {
  it("reads paths", () => {
    expect(describeSource("/a/b.png")).toEqual({ kind: "path", path: "/a/b.png" });
    expect(describeSource("b.png")).toEqual({ kind: "path", path: resolve("b.png") });
    expect(describeSource("~/b.png")).toEqual({ kind: "path", path: `${homedir()}/b.png` });
    expect(describeSource("file:///a/b%20c.png")).toEqual({ kind: "path", path: "/a/b c.png" });
    // long, extensionless, and all base64 characters — but shaped like a path
    const long = `/Users/someone/${"x".repeat(80)}`;
    expect(describeSource(long)).toEqual({ kind: "path", path: long });
  });

  it("reads URLs", () => {
    expect(describeSource("https://x.dev/a.png")).toEqual({
      kind: "url",
      url: "https://x.dev/a.png"
    });
  });

  it("reads base64, bare or in a data URL", () => {
    expect(describeSource(PNG_BASE64)).toEqual({ kind: "base64", base64: PNG_BASE64 });
    // a JPEG's base64 begins with `/`, like a path
    expect(describeSource(JPEG_BASE64)).toEqual({ kind: "base64", base64: JPEG_BASE64 });
    expect(describeSource(`data:image/png;base64,${PNG_BASE64}`)).toEqual({
      kind: "base64",
      base64: PNG_BASE64,
      mime: "image/png"
    });
  });

  it("reads bytes and explicit forms", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(describeSource(bytes)).toEqual({ kind: "bytes", bytes });
    expect(describeSource({ base64: "abc" })).toEqual({ kind: "base64", base64: "abc" });
    expect(describeSource({ path: "/x" })).toEqual({ kind: "path", path: "/x" });
  });
});

describe("sourceKey", () => {
  it("keys object forms by their contents", () => {
    expect(sourceKey({ path: "/x" })).toBe(sourceKey({ path: "/x" }));
    expect(sourceKey({ path: "/x" })).not.toBe(sourceKey("/x"));
  });
});
