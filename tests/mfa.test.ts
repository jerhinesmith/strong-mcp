import { describe, expect, it, vi } from "vitest";
import { submitMfaCode } from "../src/auth/mfa.js";

// Synthetic access token: userId 0000…, exp 1784685666 (matches the other suites).
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.sig";
const USER_ID = "00000000-0000-4000-8000-000000000000";

const CHALLENGE = "c84d1c63-edad-4ecd-83d4-c226df184636";
const REDIRECT_URL = `https://auth.strongapp.com/auth/mfa/${CHALLENGE}`;
const CALLBACK_URL = "https://strong-mcp.local/mfa-callback";

const FORM_HTML = `<form id="verifyForm" method="post">
<input id="codeInput" name="Code" />
<input id="ChallengeId" name="ChallengeId" type="hidden" value="${CHALLENGE}" />
<input id="RedirectUrl" name="RedirectUrl" type="hidden" value="${CALLBACK_URL}" />
<input name="__RequestVerificationToken" type="hidden" value="anti-forgery-token-abc" /></form>`;

function htmlRes(status: number, body: string, setCookies: string[] = []) {
  return { status, text: async () => body, headers: { getSetCookie: () => setCookies } };
}

function jsonRes(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body), headers: { getSetCookie: () => [] } };
}

describe("submitMfaCode()", () => {
  it("walks the form → redirect → verify chain and returns tokens", async () => {
    const redirectScript = `<script>var openStrong = function () { window.location = "${CALLBACK_URL}?challenge=${CHALLENGE}&token=CfDJ8AsQ%2Bblob%3D"; };</script>`;
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return htmlRes(200, FORM_HTML, ["session=abc; Path=/", "ARRAffinity=xyz; Path=/"]);
      }
      if (calls.length === 2) return htmlRes(200, redirectScript);
      return jsonRes(200, {
        accessToken: TOKEN,
        refreshToken: "refresh-mfa",
        expiresIn: 1200,
        userId: USER_ID,
      });
    });

    const result = await submitMfaCode(fetchImpl as any, {
      redirectUrl: REDIRECT_URL,
      challenge: CHALLENGE,
      code: "770319",
      deviceId: "dev-1",
    });

    expect(result).toEqual({
      accessToken: TOKEN,
      refreshToken: "refresh-mfa",
      userId: USER_ID,
      deviceId: "dev-1",
      expiresAt: 1784685666 * 1000,
    });

    // step 1: GET the code-entry form, with our own callback appended
    expect(calls[0].url).toBe(`${REDIRECT_URL}?redirectUrl=${encodeURIComponent(CALLBACK_URL)}`);
    expect(calls[0].init.method).toBe("GET");

    // step 2: POST the code, form-urlencoded, cookies from step 1 forwarded
    expect(calls[1].url).toBe(calls[0].url);
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[1].init.headers.Cookie).toBe("session=abc; ARRAffinity=xyz");
    const posted = new URLSearchParams(calls[1].init.body);
    expect(posted.get("Code")).toBe("770319");
    expect(posted.get("ChallengeId")).toBe(CHALLENGE);
    expect(posted.get("RedirectUrl")).toBe(CALLBACK_URL);
    expect(posted.get("__RequestVerificationToken")).toBe("anti-forgery-token-abc");

    // step 3: exchange the redeemed token for the real token pair
    expect(calls[2].url).toMatch(/\/auth\/mfa\/verify$/);
    expect(calls[2].init.method).toBe("POST");
    expect(JSON.parse(calls[2].init.body)).toEqual({
      token: "CfDJ8AsQ+blob=",
      challenge: CHALLENGE,
    });
  });

  it("throws when the code-entry form has no antiforgery token", async () => {
    const fetchImpl = vi.fn(async () => htmlRes(200, "<form></form>"));
    await expect(
      submitMfaCode(fetchImpl as any, {
        redirectUrl: REDIRECT_URL,
        challenge: CHALLENGE,
        code: "770319",
        deviceId: "dev-1",
      }),
    ).rejects.toThrow(/verification token/i);
  });

  it("throws a clear error when the challenge has too many attempts", async () => {
    const tooManyHtml = FORM_HTML.replace(
      "</form>",
      `<div class="notice error">Too many attempts. Please log in again.</div></form>`,
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(htmlRes(200, FORM_HTML, ["session=abc; Path=/"]))
      .mockResolvedValueOnce(htmlRes(200, tooManyHtml));
    await expect(
      submitMfaCode(fetchImpl as any, {
        redirectUrl: REDIRECT_URL,
        challenge: CHALLENGE,
        code: "770319",
        deviceId: "dev-1",
      }),
    ).rejects.toThrow(/too many attempts/i);
  });

  it("throws a clear error when the code is wrong or expired (no redirect issued)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(htmlRes(200, FORM_HTML, ["session=abc; Path=/"]))
      .mockResolvedValueOnce(htmlRes(200, FORM_HTML)); // re-rendered form, no redirect script
    await expect(
      submitMfaCode(fetchImpl as any, {
        redirectUrl: REDIRECT_URL,
        challenge: CHALLENGE,
        code: "000000",
        deviceId: "dev-1",
      }),
    ).rejects.toThrow(/incorrect or expired/i);
  });

  it("throws when the final verify call fails", async () => {
    const redirectScript = `<script>window.location = "${CALLBACK_URL}?challenge=${CHALLENGE}&token=abc";</script>`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(htmlRes(200, FORM_HTML, ["session=abc; Path=/"]))
      .mockResolvedValueOnce(htmlRes(200, redirectScript))
      .mockResolvedValueOnce(jsonRes(401, { error: "unauthorized" }));
    await expect(
      submitMfaCode(fetchImpl as any, {
        redirectUrl: REDIRECT_URL,
        challenge: CHALLENGE,
        code: "770319",
        deviceId: "dev-1",
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("throws when the verify response is missing tokens", async () => {
    const redirectScript = `<script>window.location = "${CALLBACK_URL}?challenge=${CHALLENGE}&token=abc";</script>`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(htmlRes(200, FORM_HTML, ["session=abc; Path=/"]))
      .mockResolvedValueOnce(htmlRes(200, redirectScript))
      .mockResolvedValueOnce(jsonRes(200, { accessToken: TOKEN })); // no refreshToken
    await expect(
      submitMfaCode(fetchImpl as any, {
        redirectUrl: REDIRECT_URL,
        challenge: CHALLENGE,
        code: "770319",
        deviceId: "dev-1",
      }),
    ).rejects.toThrow(/missing accessToken\/refreshToken/i);
  });
});
