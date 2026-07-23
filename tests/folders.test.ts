import { describe, it, expect } from "vitest";
import { defaultFolder, addTemplateToFolder, removeTemplateFromFolder, findFolderContaining } from "../src/write/folders.js";
import { makeClock } from "../src/write/ids.js";
import type { Snapshot } from "../src/types.js";

const clock = makeClock(() => 1784685666000);

function snap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null, preferences: {},
    entities: {
      template: {}, log: {}, measurement: {}, measuredValue: {},
      folder: {
        "u-my-templates": { id: "u-my-templates", isHidden: false, name: { en: "My Templates" }, _links: { template: [{ href: "/api/users/u/templates/t0" }] } },
      },
      tag: {}, metric: {}, widget: {},
    },
  };
}

describe("folders", () => {
  it("defaultFolder picks the -my-templates folder", () => {
    expect(defaultFolder(snap())!.id).toBe("u-my-templates");
  });
  it("addTemplateToFolder appends the href without duplicating", () => {
    const f = snap().entities.folder["u-my-templates"];
    const out = addTemplateToFolder(f, "u", "t1", clock) as any;
    expect(out._links.template.map((l: any) => l.href)).toEqual([
      "/api/users/u/templates/t0", "/api/users/u/templates/t1",
    ]);
    // idempotent
    const again = addTemplateToFolder(out, "u", "t1", clock) as any;
    expect(again._links.template).toHaveLength(2);
    expect(f._links.template).toHaveLength(1); // input untouched
  });
  it("removeTemplateFromFolder drops the href", () => {
    const f = snap().entities.folder["u-my-templates"];
    const out = removeTemplateFromFolder(f, "u", "t0", clock) as any;
    expect(out._links.template).toEqual([]);
  });
  it("findFolderContaining locates the folder holding a template link", () => {
    expect(findFolderContaining(snap(), "u", "t0")!.id).toBe("u-my-templates");
    expect(findFolderContaining(snap(), "u", "nope")).toBeUndefined();
  });
});
