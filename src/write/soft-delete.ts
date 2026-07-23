import type { Entity } from "../types.js";
import type { Clock } from "./ids.js";

export function softDelete(entity: Entity, clock: Clock): Entity {
  const clone = structuredClone(entity) as any;
  clone.isHidden = true;
  clone.lastChanged = clock();

  const groups = clone._embedded?.cellSetGroup;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      group.isHidden = true;
      const cellSets = Array.isArray(group.cellSets) ? group.cellSets : [];
      for (const cs of cellSets) {
        cs.isHidden = true;
        const cells = Array.isArray(cs.cells) ? cs.cells : [];
        for (const cell of cells) cell.isHidden = true;
      }
    }
  }
  return clone as Entity;
}
