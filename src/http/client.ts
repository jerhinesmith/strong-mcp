import { ProxyAgent } from "undici";
import { BASE_URL, CLIENT_HEADERS } from "../constants.js";
import type { TokenManager, RefreshFn } from "../auth/token-manager.js";

export type FetchLike = (
  url: string,
  init: any,
) => Promise<{ status: number; text: () => Promise<string> }>;

interface Options {
  tokenManager: TokenManager;
  fetchImpl: FetchLike;
  proxyUrl?: string;
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StrongHttpClient {
  private readonly dispatcher?: ProxyAgent;
  private readonly maxRetries: number;

  constructor(private readonly opts: Options) {
    this.maxRetries = opts.maxRetries ?? 2;
    this.dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
  }

  async getJson<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    let token = await this.opts.tokenManager.getAccessToken();
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const init: any = {
        method: "GET",
        headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` },
      };
      if (this.dispatcher) init.dispatcher = this.dispatcher;

      let r: { status: number; text: () => Promise<string> };
      try {
        r = await this.opts.fetchImpl(url, init);
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw new Error(`GET ${path} failed: ${(err as Error).message}`);
      }

      if (r.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.opts.tokenManager.forceRefresh();
        continue;
      }
      if (r.status >= 500 && attempt < this.maxRetries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      const body = await r.text();
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`GET ${path} → HTTP ${r.status}`);
      }
      return (body ? JSON.parse(body) : {}) as T;
    }
  }
}

/** Builds the RefreshFn used by TokenManager (POST /auth/login/refresh, no bearer). */
export function buildRefreshFn(fetchImpl: FetchLike, proxyUrl?: string): RefreshFn {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return async (bodyIn) => {
    const init: any = {
      method: "POST",
      headers: { ...CLIENT_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(bodyIn),
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const r = await fetchImpl(`${BASE_URL}/auth/login/refresh`, init);
    if (r.status < 200 || r.status >= 300) throw new Error(`refresh HTTP ${r.status}`);
    return JSON.parse(await r.text());
  };
}
