import type { Clock } from "./ids.js";
import type { Entity, Snapshot } from "../types.js";

export const templateHref = (userId: string, templateId: string): string =>
  `/api/users/${userId}/templates/${templateId}`;

function visibleFolders(snapshot: Snapshot): Entity[] {
  return Object.values(snapshot.entities.folder).filter((f) => f.isHidden !== true);
}

export function defaultFolder(snapshot: Snapshot): Entity | undefined {
  const folders = visibleFolders(snapshot);
  return folders.find((f) => f.id.endsWith("-my-templates")) ?? folders[0];
}

function links(folder: any): { href: string }[] {
  const l = folder._links?.template;
  return Array.isArray(l) ? l : [];
}

export function addTemplateToFolder(folder: Entity, userId: string, templateId: string, clock: Clock): Entity {
  const clone = structuredClone(folder) as any;
  const href = templateHref(userId, templateId);
  const current = links(clone);
  if (!current.some((l) => l.href === href)) current.push({ href });
  clone._links = { ...(clone._links ?? {}), template: current };
  clone.lastChanged = clock();
  return clone as Entity;
}

export function removeTemplateFromFolder(folder: Entity, userId: string, templateId: string, clock: Clock): Entity {
  const clone = structuredClone(folder) as any;
  const href = templateHref(userId, templateId);
  clone._links = { ...(clone._links ?? {}), template: links(clone).filter((l) => l.href !== href) };
  clone.lastChanged = clock();
  return clone as Entity;
}

export function findFolderContaining(snapshot: Snapshot, userId: string, templateId: string): Entity | undefined {
  const href = templateHref(userId, templateId);
  return visibleFolders(snapshot).find((f) => links(f).some((l) => l.href === href));
}
