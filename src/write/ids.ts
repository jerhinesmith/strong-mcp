import { randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export type Clock = () => string;

export function makeClock(now: () => number = Date.now): Clock {
  return () => new Date(now()).toISOString();
}
