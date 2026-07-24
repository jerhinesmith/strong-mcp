const NAMEID_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

export function decodeJwt(token: string): { userId: string; expMs: number } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed JWT payload");
  }
  const userId = payload[NAMEID_CLAIM];
  const exp = payload.exp;
  if (typeof userId !== "string" || typeof exp !== "number") {
    throw new Error("JWT missing userId or exp claim");
  }
  return { userId, expMs: exp * 1000 };
}
