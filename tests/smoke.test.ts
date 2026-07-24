import { describe, expect, it } from "vitest";
import { COLLECTIONS, SYNC_INCLUDE } from "../src/constants.js";

describe("scaffold", () => {
  it("builds the exhaustive include string from all 8 collections", () => {
    expect(COLLECTIONS).toHaveLength(8);
    expect(SYNC_INCLUDE).toBe(
      "include=template&include=log&include=measurement&include=widget&include=tag&include=folder&include=metric&include=measuredValue",
    );
  });
});
