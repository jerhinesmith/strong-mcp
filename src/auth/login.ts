import { ProxyAgent } from "undici";
import { BASE_URL, CLIENT_HEADERS } from "../constants.js";
import type { FetchLike } from "../http/client.js";
import { decodeJwt } from "./jwt.js";

export interface LoginCreds {
  usernameOrEmail: string;
  password: string;
  deviceId: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceId: string;
  expiresAt: number; // epoch ms, from the access token's exp claim
}

/**
 * Mint a fresh token pair from an email + password via POST /auth/login.
 * Pure over its fetch dependency (mirrors buildRefreshFn) so it can be unit
 * tested with a mock. Never logs the password.
 */
export async function login(
  fetchImpl: FetchLike,
  creds: LoginCreds,
  proxyUrl?: string,
): Promise<LoginResult> {
  const init: any = {
    method: "POST",
    headers: { ...CLIENT_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  };
  if (proxyUrl) init.dispatcher = new ProxyAgent(proxyUrl);

  const r = await fetchImpl(`${BASE_URL}/auth/login`, init);
  const body = await r.text();
  if (r.status === 401 || r.status === 403) {
    throw new Error("Login failed: incorrect email or password.");
  }
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Login failed: HTTP ${r.status}`);
  }

  let data: { accessToken?: unknown; refreshToken?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Login failed: unexpected response from Strong.");
  }
  if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string") {
    throw new Error("Login failed: response missing accessToken/refreshToken.");
  }

  const { userId, expMs } = decodeJwt(data.accessToken);
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    userId,
    deviceId: creds.deviceId,
    expiresAt: expMs,
  };
}
