import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../storage/atomic-json.js";
import { COLLECTIONS } from "../constants.js";
import type { Snapshot, EntityMap, CollectionName } from "../types.js";

export class SnapshotStore {
  private readonly path: string;
  constructor(dataDir: string, private readonly userId: string) {
    this.path = join(dataDir, "snapshot.json");
  }

  empty(): Snapshot {
    const entities = {} as Record<CollectionName, EntityMap>;
    for (const c of COLLECTIONS) entities[c] = {};
    return { userId: this.userId, continuation: null, syncedAt: null, preferences: {}, entities };
  }

  async load(): Promise<Snapshot> {
    const stored = await readJson<Snapshot>(this.path);
    return stored ?? this.empty();
  }

  save(s: Snapshot): Promise<void> {
    return writeJsonAtomic(this.path, s);
  }
}
