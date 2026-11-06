// biome-ignore-all lint/suspicious/noControlCharactersInRegex: terminal answers are escape codes
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./kitty.ts";
import type { Size, TerminalCapabilities } from "./types.ts";

type Env = Record<string, string | undefined>;

/** A cell's size when the terminal won't say: the usual 1:2 of a monospace font. */
export const DEFAULT_CELL: Size = { width: 10, height: 20 };

/** The environment variable that forces a protocol: `kitty` or `none`. */
export const PROTOCOL_ENV = "BETTER_INK_PICTURE_PROTOCOL";

const QUERY_ID = 0x1b17;
const FILE_QUERY_ID = 0x1b18;

/** What a terminal answered to the detection queries. */
export type Answers = {
  /** Kitty graphics, sent directly. */
  graphics?: boolean;
  /** Kitty graphics, read from a file this process wrote. */
  fileTransfer?: boolean;
  cell?: Size;
  window?: Size;
  terminal?: { name: string; version?: string };
  /** Whether primary device attributes came back — the last answer, so the rest are in. */
  done: boolean;
};

/** Reads every answer out of what the terminal wrote back. */
export const parseAnswers = (input: string): Answers => {
  const answers: Answers = { done: /\u001b\[\?[\d;]*c/.test(input) };

  for (const match of input.matchAll(/\u001b_G([^;\u001b]*);([^\u001b]*)\u001b\\/g)) {
    const id = Number(/(?:^|,)i=(\d+)/.exec(match[1] ?? "")?.[1]);
    const ok = match[2] === "OK";
    if (id === QUERY_ID) answers.graphics = ok;
    if (id === FILE_QUERY_ID) answers.fileTransfer = ok;
  }

  const cell = /\u001b\[6;(\d+);(\d+)t/.exec(input);
  if (cell) {
    const size = { height: Number(cell[1]), width: Number(cell[2]) };
    if (size.width > 0 && size.height > 0) answers.cell = size;
  }
  const window = /\u001b\[4;(\d+);(\d+)t/.exec(input);
  if (window) {
    const size = { height: Number(window[1]), width: Number(window[2]) };
    if (size.width > 0 && size.height > 0) answers.window = size;
  }

  const version = /\u001bP>\|([^\u001b]*)\u001b\\/.exec(input);
  if (version?.[1]) {
    // `kitty(0.36.4)`, `ghostty 1.1.3`, `WezTerm 20240203-110809-5046fc22`
    const parts = /^([^\s(]+)[\s(]*([^)\s]*)/.exec(version[1].trim());
    if (parts?.[1]) answers.terminal = { name: parts[1], version: parts[2] || undefined };
  }
  return answers;
};

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Terminals that draw Unicode placeholders, by the name they give: answering
 * the graphics query isn't enough, since WezTerm and Konsole answer it but
 * draw no placeholders.
 */
const drawsPlaceholders = (terminal: { name: string; version?: string }) => {
  const name = terminal.name.toLowerCase();
  if (name === "ghostty") return true;
  if (name === "kitty")
    return !terminal.version || compareVersions(terminal.version, "0.28.0") >= 0;
  return false;
};

/** Placeholder terminals named by the environment, for when XTVERSION goes unanswered. */
const placeholderTerminalFromEnv = (env: Env) =>
  env.TERM === "xterm-kitty" ||
  env.TERM === "xterm-ghostty" ||
  env.TERM_PROGRAM?.toLowerCase() === "ghostty";

/**
 * Whether a terminal opens OSC 8 hyperlinks. No terminal can be asked, so
 * this goes by its name and environment; `FORCE_HYPERLINK` overrides.
 */
export const supportsHyperlinks = (env: Env, terminal?: { name: string; version?: string }) => {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== "0";
  // inside a multiplexer, links reach the outer terminal only when set up to
  if (env.TMUX || env.STY) return false;

  const name = terminal?.name.toLowerCase();
  if (
    name &&
    ["kitty", "ghostty", "wezterm", "foot", "contour", "konsole", "alacritty", "rio"].includes(name)
  ) {
    return true;
  }
  if (name === "iterm2") return true;

  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION || env.DOMTERM) return true;
  if (env.VTE_VERSION && Number(env.VTE_VERSION) >= 5000) return true;
  if (env.TERM && /^(xterm-kitty|xterm-ghostty|alacritty|foot|wezterm|contour)/.test(env.TERM)) {
    return true;
  }
  switch (env.TERM_PROGRAM) {
    case "ghostty":
    case "WezTerm":
    case "rio":
      return true;
    case "iTerm.app":
      return compareVersions(env.TERM_PROGRAM_VERSION ?? "0", "3.1") >= 0;
    case "vscode":
      return compareVersions(env.TERM_PROGRAM_VERSION ?? "0", "1.72") >= 0;
    default:
      return false;
  }
};

const forcedProtocol = (env: Env) => {
  const value = env[PROTOCOL_ENV]?.toLowerCase();
  return value === "kitty" || value === "none" ? value : undefined;
};

/**
 * Capabilities from what a terminal answered, filled out from the
 * environment where it said nothing.
 */
export const resolveCapabilities = (answers: Answers, env: Env): TerminalCapabilities => {
  const forced = forcedProtocol(env);
  const placeholders = answers.terminal
    ? drawsPlaceholders(answers.terminal)
    : placeholderTerminalFromEnv(env);
  const protocol = forced ?? (answers.graphics && placeholders ? "kitty" : "none");
  return {
    protocol,
    fileTransfer: protocol === "kitty" && answers.fileTransfer === true,
    hyperlinks: supportsHyperlinks(env, answers.terminal),
    cell: answers.cell ?? DEFAULT_CELL,
    window: answers.window,
    terminal: answers.terminal,
    detectedBy: forced ? "override" : "query"
  };
};

/**
 * Capabilities from the environment alone, for when the terminal can't be
 * asked. Less sure than {@link detectTerminal}: an environment variable
 * survives into places its terminal doesn't (tmux, SSH), so this guesses
 * `kitty` only for a local, unmultiplexed Kitty or Ghostty.
 */
export const capabilitiesFromEnvironment = (env: Env = process.env): TerminalCapabilities => {
  const forced = forcedProtocol(env);
  const local = !env.SSH_TTY && !env.SSH_CONNECTION && !env.TMUX && !env.STY;
  const kitty = local && placeholderTerminalFromEnv(env);
  const protocol = forced ?? (kitty ? "kitty" : "none");
  return {
    protocol,
    fileTransfer: protocol === "kitty" && local,
    hyperlinks: supportsHyperlinks(env),
    cell: DEFAULT_CELL,
    detectedBy: forced ? "override" : "environment"
  };
};

export type DetectOptions = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: Env;
  /** How long to wait for the terminal's answers, in ms. */
  timeout?: number;
};

/**
 * Asks the terminal what it can do: whether it speaks Kitty graphics, both
 * sent directly and read from a file; its cell and window sizes in pixels;
 * and its name. Primary device attributes, which every terminal answers, are
 * asked last, so their answer means the rest are in — this waits as long as
 * the terminal takes to answer and no longer, and the timeout covers only a
 * terminal that answers nothing.
 *
 * Call it before Ink's `render()`: it reads stdin in raw mode, and once Ink
 * owns stdin the answers would arrive as keystrokes.
 */
export const detectTerminal = async ({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  timeout = 1000
}: DetectOptions = {}): Promise<TerminalCapabilities> => {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return capabilitiesFromEnvironment(env);
  }

  // a 1×1 RGB file for the terminal to read, if it shares our file system
  const directory = join(tmpdir(), "better-ink-picture");
  const probe = join(directory, `probe-${process.pid}.rgb`);
  let wroteProbe = false;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(probe, new Uint8Array([0, 0, 0]));
    wroteProbe = true;
  } catch {}

  const queries = [
    command({ i: QUERY_ID, s: 1, v: 1, a: "q", t: "d", f: 24 }, "AAAA"),
    wroteProbe
      ? command(
          { i: FILE_QUERY_ID, s: 1, v: 1, a: "q", t: "f", f: 24 },
          Buffer.from(probe).toString("base64")
        )
      : "",
    "\u001b[16t", // cell size in pixels
    "\u001b[14t", // window size in pixels
    "\u001b[>0q", // XTVERSION
    "\u001b[c" // primary device attributes
  ].join("");

  const wasRaw = stdin.isRaw;
  let input = "";
  const answers = await new Promise<Answers>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      resolve(parseAnswers(input));
    };
    const onData = (data: Buffer | string) => {
      input += typeof data === "string" ? data : data.toString("latin1");
      if (parseAnswers(input).done) finish();
    };
    const timer = setTimeout(finish, timeout);
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stdout.write(queries);
  });

  stdin.setRawMode(wasRaw);
  stdin.pause();
  if (wroteProbe) rmSync(probe, { force: true });

  return resolveCapabilities(answers, env);
};
