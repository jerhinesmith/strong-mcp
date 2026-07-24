import { describe, expect, it } from "vitest";
import { makeClock } from "../src/write/ids.js";
import { softDelete } from "../src/write/soft-delete.js";

const clock = makeClock(() => 1784685666000);

describe("softDelete", () => {
  it("flat entity: flips isHidden and bumps lastChanged without mutating input", () => {
    const input = { id: "v1", isHidden: false, value: 90, lastChanged: "2020-01-01T00:00:00.000Z" };
    const out = softDelete(input, clock);
    expect(out.isHidden).toBe(true);
    expect(out.lastChanged).toBe("2026-07-22T02:01:06.000Z");
    expect(out.value).toBe(90); // untouched fields preserved
    expect(input.isHidden).toBe(false); // input not mutated
  });

  it("nested entity: cascades isHidden to log, groups, cellSets, and cells", () => {
    const log = {
      id: "w1",
      isHidden: false,
      logType: "WORKOUT",
      _embedded: {
        cellSetGroup: [
          {
            id: "g1",
            isHidden: false,
            cellSets: [
              {
                id: "s1",
                isHidden: false,
                cells: [{ id: "c1", cellType: "REPS", value: "12", isHidden: false }],
              },
              {
                id: "s2",
                isHidden: false,
                cells: [{ id: "c2", cellType: "REST_TIMER", value: "85", isHidden: false }],
              },
            ],
          },
        ],
      },
    };
    const out = softDelete(log, clock);
    expect(out.isHidden).toBe(true);
    const g = (out._embedded as any).cellSetGroup[0];
    expect(g.isHidden).toBe(true);
    expect(g.cellSets[0].isHidden).toBe(true);
    expect(g.cellSets[0].cells[0].isHidden).toBe(true);
    expect(g.cellSets[1].cells[0].isHidden).toBe(true);
    // input untouched
    expect((log._embedded as any).cellSetGroup[0].cellSets[0].cells[0].isHidden).toBe(false);
  });
});
