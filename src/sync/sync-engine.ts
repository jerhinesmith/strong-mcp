import { SYNC_INCLUDE, SYNC_LIMIT } from "../constants.js";
import { applyPage, isEmptyPage, nextCursor } from "./normalize.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { Snapshot } from "../types.js";

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
    return cursor ? `${base}&continuation=${encodeURIComponent(cursor)}` : base;
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

  private async walk(snapshot: Snapshot, startCursor: string | null) {
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
        await this.opts.store.save(snapshot);
        return { pages, snapshot };
      }
    }
  }
}
