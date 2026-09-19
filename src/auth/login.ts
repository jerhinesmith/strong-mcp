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
 * Thrown when POST /auth/login returns a 403 with `code: "MFA_REQUIRED"`
 * instead of a plain auth failure. `redirectUrl` is the auth.strongapp.com
 * page that issues the code-verification form for this `challenge`.
 */
export class MfaRequiredError extends Error {
  constructor(
    public readonly challenge: string,
    public readonly redirectUrl: string,
    public readonly messageToUser: string,
  ) {
    super(messageToUser);
    this.name = "MfaRequiredError";
  }
}

/**
 * Mint a fresh token pair from an email + password via POST /auth/login.
 * Pure over its fetch dependency (mirrors buildRefreshFn) so it can be unit
 * tested with a mock. Never logs the password, and deliberately takes NO proxy:
 * the login request must never be routed through a TLS-terminating debug proxy
 * where the plaintext password could be captured.
 */
export async function login(fetchImpl: FetchLike, creds: LoginCreds): Promise<LoginResult> {
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
  const body = await r.text();
  if (r.status === 403) {
    const challenge = tryParseMfaChallenge(body);
    if (challenge) {
      throw new MfaRequiredError(
        challenge.challenge,
        challenge.redirectUrl,
        challenge.messageToUser,
      );
    }
  }
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

function tryParseMfaChallenge(
  body: string,
): { challenge: string; redirectUrl: string; messageToUser: string } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed.code !== "MFA_REQUIRED" || typeof parsed.challenge !== "string") return undefined;
  return {
    challenge: parsed.challenge,
    redirectUrl: typeof parsed.redirectUrl === "string" ? parsed.redirectUrl : "",
    messageToUser:
      typeof parsed.messageToUser === "string" ? parsed.messageToUser : "Verification required.",
  };
}
