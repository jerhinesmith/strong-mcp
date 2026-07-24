import { describe, expect, it } from "vitest";
import { makeClock, newId } from "../src/write/ids.js";

describe("ids", () => {
  it("newId returns a v4 UUID", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newId()).not.toBe(id);
  });
  it("makeClock formats the injected millis as ISO-8601", () => {
    const clock = makeClock(() => 1784685666000);
    expect(clock()).toBe("2026-07-22T02:01:06.000Z");
  });
  it("makeClock defaults to Date.now", () => {
    expect(makeClock()()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
