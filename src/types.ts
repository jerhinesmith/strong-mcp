import type { COLLECTIONS } from "./constants.js";

export type CollectionName = (typeof COLLECTIONS)[number];

export interface Entity {
  id: string;
  isHidden?: boolean;
  [key: string]: unknown;
}

export type EntityMap = Record<string, Entity>;

export interface Snapshot {
  userId: string;
  continuation: string | null;
  syncedAt: string | null;
  preferences: Record<string, unknown>;
  entities: Record<CollectionName, EntityMap>;
}
