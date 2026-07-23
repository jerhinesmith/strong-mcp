import { COLLECTIONS } from "../constants.js";
import type { CollectionName, Entity } from "../types.js";

export interface Change {
  collection: CollectionName;
  entity: Entity;
}

export function buildEnvelope(
  userId: string,
  changes: Change[],
): { id: string; strongAnalytics: false; _embedded: Record<CollectionName, Entity[]> } {
  const embedded = {} as Record<CollectionName, Entity[]>;
  for (const c of COLLECTIONS) embedded[c] = [];
  for (const { collection, entity } of changes) embedded[collection].push(entity);
  return { id: userId, strongAnalytics: false, _embedded: embedded };
}
