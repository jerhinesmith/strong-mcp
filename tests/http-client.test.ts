import { describe, expect, it, vi } from "vitest";
import { StrongHttpClient } from "../src/http/client.js";

function res(status: number, body: unknown) {
  return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

const fakeTM = () => {
  let n = 0;
  return {
    getAccessToken: vi.fn(async () => `access-${n}`),
    forceRefresh: vi.fn(async () => `access-${++n}`),
  } as any;
};

describe("StrongHttpClient", () => {
  it("sends bearer + client headers and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => res(200, { ok: true }));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl });
    const out = await client.getJson<{ ok: boolean }>("/api/users/u/");
    expect(out).toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer access-0");
    expect(init.headers["User-Agent"]).toBe("Strong iOS");
  });

  it("refreshes once and retries on 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(401, "unauthorized"))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const tm = fakeTM();
    const client = new StrongHttpClient({ tokenManager: tm, fetchImpl });
    expect(await client.getJson("/x")).toEqual({ ok: 1 });
    expect(tm.forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx then throws after maxRetries", async () => {
    const fetchImpl = vi.fn(async () => res(503, "down"));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl, maxRetries: 2 });
    await expect(client.getJson("/x")).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("StrongHttpClient.putUserDoc", () => {
  it("PUTs with bearer + content-type and resolves on 2xx empty body", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => "" }));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl });
    await expect(client.putUserDoc("u", { id: "u" })).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/api/users/u");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(init.body)).toEqual({ id: "u" });
  });

  it("refreshes once and retries on 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, text: async () => "" })
      .mockResolvedValueOnce({ status: 204, text: async () => "" });
    const tm = fakeTM();
    const client = new StrongHttpClient({ tokenManager: tm, fetchImpl });
    await client.putUserDoc("u", {});
    expect(tm.forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 500 (write may have landed) and throws with the status", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, text: async () => "err" }));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl });
    await expect(client.putUserDoc("u", {})).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
