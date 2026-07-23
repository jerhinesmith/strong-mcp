import { buildEnvelope, type Change } from "./envelope.js";
import type { Snapshot } from "../types.js";

export interface WriteDeps {
  userId: string;
  refresh: () => Promise<Snapshot>;
  put: (envelope: unknown) => Promise<void>;
  persist: (snapshot: Snapshot) => Promise<void>;
}

export interface BuildResult<T> {
  changes: Change[];
  summary: T;
}

export class WriteEngine {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: WriteDeps) {}

  write<T>(build: (snapshot: Snapshot) => BuildResult<T>): Promise<T> {
    const run = this.tail.then(
      () => this.runOne(build),
      () => this.runOne(build), // prior failure must not block this write
    );
    this.tail = run.then(() => {}, () => {}); // swallow so the queue keeps moving
    return run;
  }

  private async runOne<T>(build: (snapshot: Snapshot) => BuildResult<T>): Promise<T> {
    const snapshot = await this.deps.refresh(); // delta-sync; cross-links fresh
    const { changes, summary } = build(snapshot);
    const envelope = buildEnvelope(this.deps.userId, changes);
    await this.deps.put(envelope); // throws on non-2xx → snapshot untouched below
    for (const { collection, entity } of changes) {
      snapshot.entities[collection][entity.id] = entity; // idempotent replace by id
    }
    await this.deps.persist(snapshot);
    return summary;
  }
}
