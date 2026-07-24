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
}

export interface RunLoginDeps {
  fetchImpl: FetchLike;
  dataDir: string;
  prompts: LoginPrompts;
  /** Existing deviceId to reuse (from a prior token.json); else a new one is minted. */
  existingDeviceId?: string;
  proxyUrl?: string;
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

  const usernameOrEmail = (await deps.prompts.question("Strong email: ")).trim();
  if (!usernameOrEmail) throw new Error("Email is required.");
  const password = await deps.prompts.password("Password: ");
  if (!password) throw new Error("Password is required.");

  // Reuse the deviceId from a prior login if present, else mint a stable one.
  const deviceId = deps.existingDeviceId ?? randomUUID();

  const result = await login(
    deps.fetchImpl,
    { usernameOrEmail, password, deviceId },
    deps.proxyUrl,
  );

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
function makeTtyPrompts(): LoginPrompts {
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

  let muted = false;
  const mutedOut = new Writable({
    write(chunk, encoding, cb) {
      if (!muted) process.stdout.write(chunk, encoding);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: mutedOut, terminal: true });

  const ask = (query: string, hidden: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      process.stdout.write(query); // written directly so the prompt always shows
      muted = hidden;
      rl.question("", (answer) => {
        if (hidden) {
          muted = false;
          process.stdout.write("\n"); // the swallowed Enter never printed a newline
        }
        resolve(answer);
      });
      rl.once("error", reject);
    });

  return {
    question: (q) => ask(q, false),
    password: (q) => ask(q, true),
  };
}

/** Default TTY prompts used by the real CLI (lazily created per invocation). */
export const ttyPrompts: LoginPrompts = {
  question: (q) => sharedTty().question(q),
  password: (q) => sharedTty().password(q),
};

let _shared: LoginPrompts | undefined;
function sharedTty(): LoginPrompts {
  if (!_shared) _shared = makeTtyPrompts();
  return _shared;
}
