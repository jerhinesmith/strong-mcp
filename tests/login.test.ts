import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { login } from "../src/auth/login.js";
import { makeMutedWriter, runLogin } from "../src/auth/login-command.js";
import { TokenStore } from "../src/auth/token-store.js";

// Synthetic access token: userId 0000…, exp 1784685666 (matches the other suites).
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.sig";
const USER_ID = "00000000-0000-4000-8000-000000000000";

function res(status: number, body: unknown) {
  return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

describe("login()", () => {
  it("POSTs credentials and returns tokens + decoded userId + expiry", async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, { accessToken: TOKEN, refreshToken: "refresh-1", expiresIn: 1200 }),
    );
    const out = await login(fetchImpl as any, {
      usernameOrEmail: "me@example.com",
      password: "secret",
      deviceId: "dev-1",
    });
    expect(out).toEqual({
      accessToken: TOKEN,
      refreshToken: "refresh-1",
      userId: USER_ID,
      deviceId: "dev-1",
      expiresAt: 1784685666 * 1000,
    });
    // hits POST /auth/login with the exact captured body shape
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/auth\/login$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      usernameOrEmail: "me@example.com",
      password: "secret",
      deviceId: "dev-1",
    });
  });

  it("maps 401 to a clear wrong-credentials error", async () => {
    const fetchImpl = vi.fn(async () => res(401, { error: "unauthorized" }));
    await expect(
      login(fetchImpl as any, { usernameOrEmail: "me", password: "bad", deviceId: "d" }),
    ).rejects.toThrow(/incorrect email or password/i);
  });

  it("maps other non-2xx to an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => res(500, "boom"));
    await expect(
      login(fetchImpl as any, { usernameOrEmail: "me", password: "p", deviceId: "d" }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response is missing tokens", async () => {
    const fetchImpl = vi.fn(async () => res(200, { accessToken: TOKEN })); // no refreshToken
    await expect(
      login(fetchImpl as any, { usernameOrEmail: "me", password: "p", deviceId: "d" }),
    ).rejects.toThrow(/missing accessToken\/refreshToken/i);
  });

  it("wraps a network rejection without leaking the password-bearing request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED secret-in-body");
    });
    await expect(
      login(fetchImpl as any, { usernameOrEmail: "me", password: "hunter2", deviceId: "d" }),
    ).rejects.toThrow(/could not reach Strong/i);
    // the raw underlying error (which had request context) is not surfaced
    await expect(
      login(fetchImpl as any, { usernameOrEmail: "me", password: "hunter2", deviceId: "d" }),
    ).rejects.not.toThrow(/hunter2/);
  });
});

describe("runLogin()", () => {
  const prompts = (email: string, password: string) => ({
    question: vi.fn(async () => email),
    password: vi.fn(async () => password),
    close: vi.fn(),
  });

  it("mints a fresh deviceId, persists token.json (readable back), and never returns the password", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "strong-login-"));
    const fetchImpl = vi.fn(async () =>
      res(200, { accessToken: TOKEN, refreshToken: "refresh-1", expiresIn: 1200 }),
    );
    const out = await runLogin({
      fetchImpl: fetchImpl as any,
      dataDir,
      prompts: prompts("me@example.com", "secret"),
      log: () => {},
    });
    expect(out.userId).toBe(USER_ID);

    const stored = await new TokenStore(dataDir).read();
    expect(stored).toMatchObject({
      accessToken: TOKEN,
      refreshToken: "refresh-1",
      userId: USER_ID,
      expiresAt: 1784685666 * 1000,
    });
    // a deviceId was generated (uuid-shaped)
    expect(stored?.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    // the sent login body carries that same generated deviceId
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).deviceId).toBe(stored?.deviceId);
    // password never appears in what we persisted
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  it("reuses an existing deviceId when one is supplied", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "strong-login-"));
    const fetchImpl = vi.fn(async () =>
      res(200, { accessToken: TOKEN, refreshToken: "refresh-2", expiresIn: 1200 }),
    );
    await runLogin({
      fetchImpl: fetchImpl as any,
      dataDir,
      prompts: prompts("me@example.com", "secret"),
      existingDeviceId: "keep-this-device",
      log: () => {},
    });
    const stored = await new TokenStore(dataDir).read();
    expect(stored?.deviceId).toBe("keep-this-device");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).deviceId).toBe("keep-this-device");
  });

  it("rejects an empty email before calling the API", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runLogin({
        fetchImpl: fetchImpl as any,
        dataDir: mkdtempSync(join(tmpdir(), "strong-login-")),
        prompts: prompts("   ", "secret"),
        log: () => {},
      }),
    ).rejects.toThrow(/email is required/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not write token.json when login fails, and still releases prompts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "strong-login-"));
    const fetchImpl = vi.fn(async () => res(401, {}));
    const p = prompts("me@example.com", "bad");
    await expect(
      runLogin({ fetchImpl: fetchImpl as any, dataDir, prompts: p, log: () => {} }),
    ).rejects.toThrow(/incorrect email or password/i);
    expect(await new TokenStore(dataDir).read()).toBeNull();
    expect(p.close).toHaveBeenCalled(); // released even on the failure path
  });

  it("closes the prompts on the success path (so the process can exit)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "strong-login-"));
    const fetchImpl = vi.fn(async () =>
      res(200, { accessToken: TOKEN, refreshToken: "refresh-1", expiresIn: 1200 }),
    );
    const p = prompts("me@example.com", "secret");
    await runLogin({ fetchImpl: fetchImpl as any, dataDir, prompts: p, log: () => {} });
    expect(p.close).toHaveBeenCalledTimes(1);
  });
});

describe("makeMutedWriter", () => {
  it("passes through when not muted and swallows when muted", () => {
    const seen: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        seen.push(chunk.toString());
        cb();
      },
    });
    const { stream, setMuted } = makeMutedWriter(sink);
    stream.write("visible-1");
    setMuted(true);
    stream.write("SECRET"); // should be swallowed
    setMuted(false);
    stream.write("visible-2");
    expect(seen.join("")).toBe("visible-1visible-2");
    expect(seen.join("")).not.toContain("SECRET");
  });
});
