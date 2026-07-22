export const BASE_URL = "https://back.strong.app";
export const KG_PER_LB = 0.45359237;
export const SYNC_LIMIT = 300;

export const COLLECTIONS = [
  "template", "log", "measurement", "widget",
  "tag", "folder", "metric", "measuredValue",
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
