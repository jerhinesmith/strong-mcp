import { describe, it, expect } from "vitest";
import { buildEnvelope } from "../src/write/envelope.js";

describe("buildEnvelope", () => {
  it("routes each change into its collection; others empty; envelope shape correct", () => {
    const env = buildEnvelope("u", [
      { collection: "log", entity: { id: "w1", logType: "WORKOUT" } },
      { collection: "template", entity: { id: "t1", logType: "TEMPLATE" } },
      { collection: "folder", entity: { id: "f1" } },
    ]);
    expect(env.id).toBe("u");
    expect(env.strongAnalytics).toBe(false);
    expect(env._embedded.log).toEqual([{ id: "w1", logType: "WORKOUT" }]);
    expect(env._embedded.template).toEqual([{ id: "t1", logType: "TEMPLATE" }]);
    expect(env._embedded.folder).toEqual([{ id: "f1" }]);
    // all 8 collections present; the untouched ones are empty arrays
    expect(Object.keys(env._embedded).sort()).toEqual(
      ["folder", "log", "measuredValue", "measurement", "metric", "tag", "template", "widget"].sort(),
    );
    expect(env._embedded.measurement).toEqual([]);
    expect(env._embedded.widget).toEqual([]);
  });

  it("supports multiple entities in one collection", () => {
    const env = buildEnvelope("u", [
      { collection: "measuredValue", entity: { id: "v1" } },
      { collection: "measuredValue", entity: { id: "v2" } },
    ]);
    expect(env._embedded.measuredValue.map((e) => e.id)).toEqual(["v1", "v2"]);
  });
});
