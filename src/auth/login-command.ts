import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { FetchLike } from "../http/client.js";
import { login } from "./login.js";
import { TokenStore } from "./token-store.js";

export interface LoginPrompts {
  /** Read a visible line (e.g. the email). */
  question: (prompt: string) => Promise<string>;
  /** Read a line without echoing keystrokes (the password). */
  password: (prompt: string) => Promise<string>;
  /** Release any held resources (e.g. the readline interface / stdin ref). */
  close?: () => void;
}

export interface RunLoginDeps {
  fetchImpl: FetchLike;
  dataDir: string;
  prompts: LoginPrompts;
  /** Existing deviceId to reuse (from a prior token.json); else a new one is minted. */
  existingDeviceId?: string;
  log?: (msg: string) => void;
}

/**
 * Core login flow, decoupled from the TTY so it can be unit tested: prompt for
 * credentials, mint tokens, persist token.json (chmod 600 via TokenStore), and
 * report success. The password lives only in a local variable and is never
 * logged or written to disk.
 */
export async function runLogin(deps: RunLoginDeps): Promise<{ userId: string }> {
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));

  try {
    const usernameOrEmail = (await deps.prompts.question("Strong email: ")).trim();
    if (!usernameOrEmail) throw new Error("Email is required.");
    const password = await deps.prompts.password("Password: ");
    if (!password) throw new Error("Password is required.");

    // Reuse the deviceId from a prior login if present, else mint a stable one.
    const deviceId = deps.existingDeviceId ?? randomUUID();

    // NOTE: login() takes no proxy — the password must never go through a
    // TLS-terminating debug proxy.
    const result = await login(deps.fetchImpl, { usernameOrEmail, password, deviceId });

    const store = new TokenStore(deps.dataDir);
    await store.write({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      deviceId: result.deviceId,
      userId: result.userId,
    });

    log(`✓ Logged in. Tokens saved to ${deps.dataDir}/token.json`);
    return { userId: result.userId };
  } finally {
    // Release the readline / stdin ref so the process can exit (success path
    // otherwise hangs on a terminal-mode readline that keeps stdin alive).
    deps.prompts.close?.();
  }
}

/**
 * TTY prompts backed by a SINGLE readline interface shared across both reads.
 * Opening a second interface on the same stdin (or closing the first) ends the
 * shared stream and makes the next read see EOF — so we create one interface,
 * reuse it for email and password, and toggle output muting for the password.
 *
 * `login` is an interactive command: it requires a real terminal so the
 * password can be typed without being echoed. If stdin is not a TTY (piped,
 * redirected, CI), fail loudly rather than dangle on an EOF'd read.
 */
/**
 * A Writable that passes through to `out` unless muted. Used to swallow the
 * echo of typed password characters. Exposed for testing; `setMuted` toggles it.
 */
export function makeMutedWriter(out: NodeJS.WritableStream): {
  stream: Writable;
  setMuted: (v: boolean) => void;
} {
  let muted = false;
  const stream = new Writable({
    write(chunk, encoding, cb) {
      if (!muted) out.write(chunk, encoding);
      cb();
    },
  });
  return { stream, setMuted: (v) => (muted = v) };
}

/**
 * Build the real TTY prompts, backed by one readline interface. Call once per
 * `login` invocation and pass the result to runLogin, which closes it when done.
 */
export function makeTtyPrompts(): LoginPrompts {
  if (!process.stdin.isTTY) {
    const notATty = () =>
      Promise.reject(
        new Error(
          "`strong-mcp login` needs an interactive terminal (stdin is not a TTY). " +
            "Run it directly in a terminal.",
        ),
      );
    return { question: notATty, password: notATty };
  }

  const { stream: mutedOut, setMuted } = makeMutedWriter(process.stdout);
  const rl = createInterface({ input: process.stdin, output: mutedOut, terminal: true });

  const ask = (query: string, hidden: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      process.stdout.write(query); // written directly so the prompt always shows
      setMuted(hidden);
      rl.question("", (answer) => {
        if (hidden) {
          setMuted(false);
          process.stdout.write("\n"); // the swallowed Enter never printed a newline
        }
        resolve(answer);
      });
      rl.once("error", reject);
    });

  return {
    question: (q) => ask(q, false),
    password: (q) => ask(q, true),
    close: () => rl.close(),
  };
}
