import { closeSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../test/fixtures.ts";
import { type ImageClient as Client, ImageClient, type Output } from "./client.ts";
import { DEFAULT_CELL } from "./detect.ts";
import { place, remove } from "./kitty.ts";
import type { TerminalCapabilities } from "./types.ts";

const kitty = (fileTransfer: boolean): TerminalCapabilities => ({
  protocol: "kitty",
  fileTransfer,
  hyperlinks: true,
  cell: DEFAULT_CELL,
  window: { width: 1000, height: 800 },
  detectedBy: "override"
});

/** A client whose "terminal" is a file, read back to see what the worker wrote. */
const setup = (capabilities: TerminalCapabilities) => {
  const directory = mkdtempSync(join(tmpdir(), "better-ink-picture-test-"));
  const terminal = join(directory, "terminal");
  const fd = openSync(terminal, "w");
  const stdout = { fd, columns: 100, rows: 40, write: () => true } as unknown as Output;
  const client = new ImageClient({
    capabilities,
    stdout,
    tmpdir: join(directory, "images"),
    releaseDelay: 10
  });
  clients.push({ client, fd });
  return { client, directory, written: () => readFileSync(terminal, "latin1") };
};

const clients: { client: Client; fd: number }[] = [];
afterEach(() => {
  for (const { client, fd } of clients.splice(0)) {
    client.dispose();
    closeSync(fd);
  }
});

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("ImageClient with Kitty graphics", () => {
  it("sends a PNG file as its path, without reading it", async () => {
    const { client, directory, written } = setup(kitty(true));
    const path = join(directory, "a.png");
    writeFileSync(path, await fixture("png", { width: 40, height: 20 }));

    const meta = await client.probe(path).promise;
    expect(meta).toMatchObject({ format: "png", width: 40, height: 20 });
    // a probe answered once is known at once after
    expect(client.probe(path).value).toBe(meta);

    const id = client.viewId(meta.key, 4, 1);
    client.retain(id);
    await vi.waitFor(() => expect(written()).toContain(place(id, 4, 1)));
    expect(written()).toContain(`\u001b_Ga=t,i=${id},f=100,q=2,t=f;${b64(path)}\u001b\\`);

    client.release(id);
    await vi.waitFor(() => expect(written()).toContain(remove(id)));
  });

  it("sends base64 as it came when the terminal can't read our files", async () => {
    const { client, written } = setup(kitty(false));
    const base64 = Buffer.from(await fixture("png")).toString("base64");

    const meta = await client.probe(base64).promise;
    const id = client.viewId(meta.key, 4, 1);
    client.retain(id);
    await vi.waitFor(() => expect(written()).toContain(place(id, 4, 1)));
    expect(written()).toContain(`t=d;${base64}\u001b\\`);
  });

  it("decodes anything else once, to raw pixels in a file", async () => {
    const { client, written } = setup(kitty(true));
    const jpeg = await fixture("jpeg", { width: 3000, height: 1000 });

    const meta = await client.probe(jpeg).promise;
    expect(meta).toMatchObject({ format: "jpeg", width: 3000, height: 1000 });

    const id = client.viewId(meta.key, 10, 2);
    client.retain(id);
    await vi.waitFor(() => expect(written()).toContain(place(id, 10, 2)));
    // shrunk to the 1000 px window, not sent at 3000 px
    const code = /a=t,i=\d+,f=32,s=(\d+),v=(\d+),q=2,t=f;([^\u001b]+)/.exec(written());
    expect([code?.[1], code?.[2]]).toEqual(["1000", "333"]);
    const file = Buffer.from(code?.[3] ?? "", "base64").toString();
    expect(statSync(file).size).toBe(1000 * 333 * 4);

    // the same image at another size reuses the decoded pixels: same file, new id
    const other = client.viewId(meta.key, 5, 1);
    client.retain(other);
    await vi.waitFor(() => expect(written()).toContain(place(other, 5, 1)));
    expect(written().split(b64(file)).length - 1).toBe(2);
  });

  it("never sends an image released before it was ready", async () => {
    const { client, written } = setup(kitty(true));
    const meta = await client.probe(await fixture("jpeg")).promise;
    const id = client.viewId(meta.key, 4, 1);
    client.retain(id);
    client.release(id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(written()).not.toContain(place(id, 4, 1));
  });

  it("fails a probe it can't read", async () => {
    const { client } = setup(kitty(true));
    await expect(client.probe("/no/such/image.png").promise).rejects.toThrow(/ENOENT/);
  });
});

describe("ImageClient without graphics", () => {
  const none: TerminalCapabilities = { ...kitty(false), protocol: "none" };

  it("links a file as itself", async () => {
    const { client, directory } = setup(none);
    const path = join(directory, "a.jpg");
    writeFileSync(path, await fixture("jpeg"));
    expect(await client.file(path).promise).toBe(path);
  });

  it("writes anything else to the temp directory once, as it came", async () => {
    const { client, directory } = setup(none);
    const bytes = await fixture("webp");
    const base64 = Buffer.from(bytes).toString("base64");
    const path = await client.file(`data:image/webp;base64,${base64}`).promise;
    expect(path.startsWith(join(directory, "images"))).toBe(true);
    expect(path.endsWith(".webp")).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  });
});
