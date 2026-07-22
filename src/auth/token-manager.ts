import { TokenStore, type TokenState } from "./token-store.js";
import { decodeJwt } from "./jwt.js";

export type RefreshFn = (body: {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;

interface Options {
  store: TokenStore;
  refreshFn: RefreshFn;
  now: () => number;
  seed: { accessToken: string; refreshToken: string; deviceId: string; userId: string };
  skewMs?: number;
}

export class TokenManager {
  private state: TokenState | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly skewMs: number;

  constructor(private readonly opts: Options) {
    this.skewMs = opts.skewMs ?? 60_000;
  }

  /** token.json is source of truth; fall back to the seed once. */
  private async load(): Promise<TokenState> {
    if (this.state) return this.state;
    const stored = await this.opts.store.read();
    if (stored) {
      this.state = stored;
      return stored;
    }
    const { seed } = this.opts;
    const { expMs } = decodeJwt(seed.accessToken);
    this.state = { ...seed, expiresAt: expMs };
    return this.state;
  }

  async getAccessToken(): Promise<string> {
    const s = await this.load();
    if (this.opts.now() >= s.expiresAt - this.skewMs) {
      return this.forceRefresh();
    }
    return s.accessToken;
  }

  forceRefresh(): Promise<string> {
    if (this.inFlight) return this.inFlight; // single-flight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<string> {
    const s = await this.load();
    let res;
    try {
      res = await this.opts.refreshFn({
        deviceId: s.deviceId,
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
      });
    } catch (err) {
      throw new Error(
        "Strong token refresh failed — re-seed STRONG_ACCESS_TOKEN/STRONG_REFRESH_TOKEN " +
          `(underlying: ${(err as Error).message})`,
      );
    }
    const { expMs } = decodeJwt(res.accessToken);
    const next: TokenState = {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken, // rotated
      expiresAt: expMs,
      deviceId: s.deviceId,
      userId: s.userId,
    };
    await this.opts.store.write(next); // persist BEFORE returning (crash-window minimized)
    this.state = next;
    return next.accessToken;
  }
}
