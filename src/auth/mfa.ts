import { BASE_URL } from "../constants.js";
import { decodeJwt } from "./jwt.js";
import type { LoginResult } from "./login.js";

/**
 * Fake redirect target for the auth.strongapp.com code-entry form. The real
 * app supplies its own URL scheme here so the form can hand the redeemed
 * token back to it; this one is never actually fetched — we only need the
 * server to echo `token`/`challenge` onto it so we can read them back out.
 */
const CALLBACK_URL = "https://strong-mcp.local/mfa-callback";

const ANTIFORGERY_RE = /name="__RequestVerificationToken"[^>]*\svalue="([^"]+)"/;
const REDIRECT_RE = /window\.location\s*=\s*"([^"]+)"/;

export type FetchLikeWithHeaders = (
  url: string,
  init: any,
) => Promise<{
  status: number;
  text: () => Promise<string>;
  headers: { getSetCookie: () => string[] };
}>;

export interface SubmitMfaCodeParams {
  /** From MfaRequiredError.redirectUrl — the auth.strongapp.com form page for this challenge. */
  redirectUrl: string;
  challenge: string;
  code: string;
  deviceId: string;
}

/**
 * Completes an email-code MFA challenge by driving the auth.strongapp.com
 * Razor form the native app would otherwise show in a webview: GET it for
 * the antiforgery token + session cookie, POST the code, pull the redeemed
 * long-form token out of the client-side redirect it returns, then exchange
 * that at POST /auth/mfa/verify for the real token pair. Mirrors login()'s
 * shape so callers can persist the result the same way.
 */
export async function submitMfaCode(
  fetchImpl: FetchLikeWithHeaders,
  params: SubmitMfaCodeParams,
): Promise<LoginResult> {
  const formUrl = `${params.redirectUrl}?redirectUrl=${encodeURIComponent(CALLBACK_URL)}`;

  const formRes = await fetchImpl(formUrl, { method: "GET" });
  const formHtml = await formRes.text();
  const cookieHeader = formRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const antiforgeryMatch = formHtml.match(ANTIFORGERY_RE);
  if (!antiforgeryMatch) {
    throw new Error(
      "MFA verification failed: could not find the verification token on Strong's code form.",
    );
  }

  const submitBody = new URLSearchParams({
    Code: params.code,
    ChallengeId: params.challenge,
    RedirectUrl: CALLBACK_URL,
    __RequestVerificationToken: antiforgeryMatch[1],
  });
  const submitRes = await fetchImpl(formUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: submitBody.toString(),
  });
  const submitHtml = await submitRes.text();

  if (/too many attempts/i.test(submitHtml)) {
    throw new Error("MFA verification failed: too many attempts — log in again for a new code.");
  }
  const redirectMatch = submitHtml.match(REDIRECT_RE);
  if (!redirectMatch) {
    throw new Error("MFA verification failed: code is incorrect or expired.");
  }

  const finalUrl = new URL(redirectMatch[1]);
  const mfaToken = finalUrl.searchParams.get("token");
  const mfaChallenge = finalUrl.searchParams.get("challenge");
  if (!mfaToken || !mfaChallenge) {
    throw new Error("MFA verification failed: unexpected response from Strong.");
  }

  const verifyRes = await fetchImpl(`${BASE_URL}/auth/mfa/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token: mfaToken, challenge: mfaChallenge }),
  });
  const verifyBody = await verifyRes.text();
  if (verifyRes.status < 200 || verifyRes.status >= 300) {
    throw new Error(`MFA verification failed: HTTP ${verifyRes.status}`);
  }

  let data: { accessToken?: unknown; refreshToken?: unknown };
  try {
    data = JSON.parse(verifyBody);
  } catch {
    throw new Error("MFA verification failed: unexpected response from Strong.");
  }
  if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string") {
    throw new Error("MFA verification failed: response missing accessToken/refreshToken.");
  }

  const { userId, expMs } = decodeJwt(data.accessToken);
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    userId,
    deviceId: params.deviceId,
    expiresAt: expMs,
  };
}
