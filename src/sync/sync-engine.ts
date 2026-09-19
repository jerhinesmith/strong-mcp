import { SYNC_INCLUDE, SYNC_LIMIT } from "../constants.js";
import type { Snapshot } from "../types.js";
import { applyPage, isEmptyPage, nextCursor } from "./normalize.js";
import type { SnapshotStore } from "./snapshot-store.js";

interface HttpGet {
  getJson<T>(path: string): Promise<T>;
}

interface Options {
  http: HttpGet;
  store: SnapshotStore;
  userId: string;
}

export class SyncEngine {
  constructor(private readonly opts: Options) {}

  private pagePath(cursor: string | null): string {
    const base = `/api/users/${this.opts.userId}/?${SYNC_INCLUDE}&limit=${SYNC_LIMIT}`;
    // `continuation` must be sent even when empty: omitting it entirely (as
    // opposed to sending `continuation=`) makes Strong return a flat,
    // silently-truncated document with no `_links.next` at all — losing
    // everything past `limit` per collection with no signal that more exists.
    return `${base}&continuation=${cursor ? encodeURIComponent(cursor) : ""}`;
  }

  async sync(): Promise<{ pages: number; snapshot: Snapshot }> {
    const snapshot = await this.opts.store.load();
    try {
      return await this.walk(snapshot, snapshot.continuation);
    } catch (err) {
      // Stale/rejected cursor → full re-sync from scratch.
      if (snapshot.continuation && /HTTP 4\d\d/.test((err as Error).message)) {
        const fresh = this.opts.store.empty();
        return this.walk(fresh, null);
      }
      throw err;
    }
  }

  /**
   * Full re-sync from scratch, ignoring the stored continuation cursor, WITHOUT
   * persisting or mutating any shared state. Returns a fresh, pristine snapshot
   * of server truth for read-only use — verifying inferred write shapes, where
   * the optimistically-applied local snapshot cannot be trusted. Kept off the
   * persistence path so it can run after a write resolves without racing the
   * serialized write queue's own snapshot swaps.
   */
  async resync(): Promise<{ pages: number; snapshot: Snapshot }> {
    return this.walk(this.opts.store.empty(), null, { persist: false });
  }

  private async walk(
    snapshot: Snapshot,
    startCursor: string | null,
    opts: { persist: boolean } = { persist: true },
  ) {
    let cursor = startCursor;
    let pages = 0;
    for (;;) {
      const page = await this.opts.http.getJson<any>(this.pagePath(cursor));
      pages++;
      applyPage(snapshot, page);
      const next = nextCursor(page);
      if (next) cursor = next;
      if (isEmptyPage(page) || !next) {
        snapshot.continuation = next ?? cursor;
        snapshot.syncedAt = new Date().toISOString();
        if (opts.persist) await this.opts.store.save(snapshot);
        return { pages, snapshot };
      }
    }
  }
}
