import { COLLECTIONS } from "../constants.js";
import type { Snapshot } from "../types.js";

export function applyPage(snapshot: Snapshot, page: any): void {
  const embedded = page?._embedded ?? {};
  for (const c of COLLECTIONS) {
    const arr = embedded[c];
    if (!Array.isArray(arr)) continue;
    for (const entity of arr) {
      if (entity && typeof entity.id === "string") {
        snapshot.entities[c][entity.id] = entity; // replace by id — idempotent
      }
    }
  }
  if (page?.preferences && typeof page.preferences === "object") {
    snapshot.preferences = page.preferences;
  }
}

export function isEmptyPage(page: any): boolean {
  const embedded = page?._embedded ?? {};
  return COLLECTIONS.every((c) => {
    const arr = embedded[c];
    return !Array.isArray(arr) || arr.length === 0;
  });
}

export function nextCursor(page: any): string | null {
  const href = page?._links?.next?.href;
  if (typeof href !== "string") return null;
  const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : href;
  const params = new URLSearchParams(q);
  return params.get("continuation");
}
