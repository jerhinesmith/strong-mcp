export const BASE_URL = "https://back.strong.app";
export const KG_PER_LB = 0.45359237;
// Strong's API rejects anything above 200 with "Limit must be between 1 and
// 200." (verified live 2026-09-18) — this was 300 pre-launch and no longer works.
export const SYNC_LIMIT = 200;

export const COLLECTIONS = [
  "template",
  "log",
  "measurement",
  "widget",
  "tag",
  "folder",
  "metric",
  "measuredValue",
] as const;

export const SYNC_INCLUDE = COLLECTIONS.map((c) => `include=${c}`).join("&");

export const CLIENT_VERSION = "6.4.2";
export const CLIENT_BUILD = "8332";

export const CLIENT_HEADERS: Record<string, string> = {
  "X-Client-Platform": "ios",
  "X-Client-Version": CLIENT_VERSION,
  "X-Client-Build": CLIENT_BUILD,
  "User-Agent": "Strong iOS",
  Accept: "application/json",
};
