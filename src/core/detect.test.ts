import {
  capabilitiesFromEnvironment,
  parseAnswers,
  resolveCapabilities,
  supportsHyperlinks
} from "./detect.ts";

const ESC = "\u001b";
const DA1 = `${ESC}[?62;22c`;

describe("parseAnswers", () => {
  it("reads every answer", () => {
    const answers = parseAnswers(
      `${ESC}_Gi=6935;OK${ESC}\\${ESC}_Gi=6936;OK${ESC}\\${ESC}[6;34;17t${ESC}[4;1360;2040t${ESC}P>|kitty(0.36.4)${ESC}\\${DA1}`
    );
    expect(answers).toEqual({
      done: true,
      graphics: true,
      fileTransfer: true,
      cell: { width: 17, height: 34 },
      window: { width: 2040, height: 1360 },
      terminal: { name: "kitty", version: "0.36.4" }
    });
  });

  it("reads a refused file transfer", () => {
    const answers = parseAnswers(`${ESC}_Gi=6935;OK${ESC}\\${ESC}_Gi=6936;EBADF:no${ESC}\\`);
    expect(answers).toMatchObject({ graphics: true, fileTransfer: false, done: false });
  });

  it("reads Ghostty's and WezTerm's names", () => {
    expect(parseAnswers(`${ESC}P>|ghostty 1.1.3${ESC}\\`).terminal).toEqual({
      name: "ghostty",
      version: "1.1.3"
    });
    expect(parseAnswers(`${ESC}P>|WezTerm 20240203-110809-5046fc22${ESC}\\`).terminal?.name).toBe(
      "WezTerm"
    );
  });
});

describe("resolveCapabilities", () => {
  const graphics = { done: true, graphics: true, fileTransfer: true };

  it("draws in terminals that draw placeholders", () => {
    for (const terminal of [
      { name: "ghostty", version: "1.1.3" },
      { name: "kitty", version: "0.36.4" }
    ]) {
      expect(resolveCapabilities({ ...graphics, terminal }, {})).toMatchObject({
        protocol: "kitty",
        fileTransfer: true,
        hyperlinks: true
      });
    }
  });

  it("links in terminals that speak graphics but draw no placeholders", () => {
    for (const terminal of [{ name: "WezTerm" }, { name: "kitty", version: "0.27.1" }]) {
      expect(resolveCapabilities({ ...graphics, terminal }, {}).protocol).toBe("none");
    }
  });

  it("links when graphics go unanswered, whatever the environment says", () => {
    // Ghostty's TERM, forwarded over SSH into a terminal that answered nothing
    const answers = { done: true, terminal: { name: "tmux", version: "3.4" } };
    expect(resolveCapabilities(answers, { TERM: "xterm-ghostty" }).protocol).toBe("none");
  });

  it("takes the environment's word for the name when XTVERSION goes unanswered", () => {
    expect(resolveCapabilities(graphics, { TERM: "xterm-kitty" }).protocol).toBe("kitty");
    expect(resolveCapabilities(graphics, {}).protocol).toBe("none");
  });

  it("can be forced", () => {
    expect(
      resolveCapabilities({ done: true }, { BETTER_INK_PICTURE_PROTOCOL: "kitty" })
    ).toMatchObject({ protocol: "kitty", detectedBy: "override" });
  });
});

describe("capabilitiesFromEnvironment", () => {
  it("guesses kitty only for a local, unmultiplexed Kitty or Ghostty", () => {
    expect(capabilitiesFromEnvironment({ TERM_PROGRAM: "ghostty" }).protocol).toBe("kitty");
    expect(capabilitiesFromEnvironment({ TERM_PROGRAM: "ghostty", TMUX: "1" }).protocol).toBe(
      "none"
    );
    expect(capabilitiesFromEnvironment({ TERM: "xterm-kitty", SSH_TTY: "/dev/x" }).protocol).toBe(
      "none"
    );
  });
});

describe("supportsHyperlinks", () => {
  it("goes by name and environment", () => {
    expect(supportsHyperlinks({}, { name: "ghostty" })).toBe(true);
    expect(supportsHyperlinks({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(supportsHyperlinks({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.0" })).toBe(
      true
    );
    expect(supportsHyperlinks({ WT_SESSION: "x" })).toBe(true);
    expect(supportsHyperlinks({ TERM_PROGRAM: "ghostty", TMUX: "1" })).toBe(false);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "1" })).toBe(true);
  });
});
