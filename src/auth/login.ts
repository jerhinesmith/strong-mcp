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
 * POST /auth/login and return the raw status + body untouched, leaving status
 * interpretation to the caller. Deliberately takes NO proxy: the password must
 * never be routed through a TLS-terminating debug proxy where it could be
 * captured in cleartext.
 */
export async function loginRaw(
  fetchImpl: FetchLike,
  creds: LoginCreds,
): Promise<{ status: number; body: string }> {
  const init: any = {
    method: "POST",
    headers: { ...CLIENT_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  };
  let r: { status: number; text: () => Promise<string> };
  try {
    r = await fetchImpl(`${BASE_URL}/auth/login`, init);
  } catch {
    // Never surface the underlying error: `init` holds the password body.
    throw new Error("Login failed: could not reach Strong. Check your connection and try again.");
  }
  return { status: r.status, body: await r.text() };
}

/**
 * Mint a fresh token pair from an email + password via POST /auth/login.
 * Pure over its fetch dependency (mirrors buildRefreshFn) so it can be unit
 * tested with a mock. Never logs the password, and deliberately takes NO proxy:
 * the login request must never be routed through a TLS-terminating debug proxy
 * where the plaintext password could be captured.
 */
export async function login(fetchImpl: FetchLike, creds: LoginCreds): Promise<LoginResult> {
  const { status, body } = await loginRaw(fetchImpl, creds);
  // Strong enforces email MFA for unrecognized devices and returns 403 with
  // code MFA_REQUIRED. That flow completes on a hosted web page and can't be
  // finished headlessly, so surface it distinctly from a bad-password 401.
  if (status === 403 && /MFA_REQUIRED/.test(body)) {
    throw new Error(
      "Login failed: Strong requires email verification (MFA) for this device, which this CLI " +
        "cannot complete. Seed a token pair via STRONG_ACCESS_TOKEN/STRONG_REFRESH_TOKEN/STRONG_DEVICE_ID instead.",
    );
  }
  if (status === 401 || status === 403) {
    throw new Error("Login failed: incorrect username/email or password.");
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Login failed: HTTP ${status}`);
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
