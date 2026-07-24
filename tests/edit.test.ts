import { describe, expect, it } from "vitest";
import { editEntityName, editSetCells } from "../src/write/edit.js";
import { makeClock } from "../src/write/ids.js";

const clock = makeClock(() => 1784685666000);
const deps = { clock, weightUnit: "POUNDS" as const };

describe("editEntityName", () => {
  it("changes name.custom and bumps lastChanged; preserves the rest", () => {
    const e = {
      id: "t1",
      name: { custom: "Old" },
      isHidden: false,
      extra: 1,
      lastChanged: "2020-01-01T00:00:00.000Z",
    };
    const out = editEntityName(e, "New", clock) as any;
    expect(out.name.custom).toBe("New");
    expect(out.lastChanged).toBe("2026-07-22T02:01:06.000Z");
    expect(out.extra).toBe(1);
    expect(e.name.custom).toBe("Old"); // input untouched
  });
});

describe("editSetCells", () => {
  const log = () => ({
    id: "w1",
    logType: "WORKOUT",
    isHidden: false,
    lastChanged: "2020-01-01T00:00:00.000Z",
    _embedded: {
      cellSetGroup: [
        {
          id: "g1",
          cellSets: [
            {
              id: "s1",
              cells: [
                { id: "c1", cellType: "BARBELL_WEIGHT", value: "13.6077711", isHidden: false }, // 30 lb, raw
                { id: "c2", cellType: "REPS", value: "12", isHidden: false },
                { id: "c3", cellType: "RPE", value: null, isHidden: false },
              ],
            },
            {
              id: "r1",
              cells: [{ id: "c4", cellType: "REST_TIMER", value: "85", isHidden: false }],
            },
            {
              id: "s2",
              cells: [
                {
                  id: "c5",
                  cellType: "BARBELL_WEIGHT",
                  value: "18.143694800000002",
                  isHidden: false,
                }, // 40 lb, raw
                { id: "c6", cellType: "REPS", value: "10", isHidden: false },
                { id: "c7", cellType: "RPE", value: null, isHidden: false },
              ],
            },
          ],
        },
      ],
    },
  });

  it("rewrites only the edited cells; untouched cells keep their raw strings verbatim", () => {
    const out = editSetCells(log(), [{ groupIndex: 0, setIndex: 0, reps: 8 }], deps) as any;
    const cells = out._embedded.cellSetGroup[0].cellSets[0].cells;
    expect(cells[1].value).toBe("8"); // reps edited
    expect(cells[0].value).toBe("13.6077711"); // weight NOT round-tripped — byte-for-byte
    expect(cells[2].value).toBeNull();
    // second working set entirely untouched, including its raw FP weight
    const set2 = out._embedded.cellSetGroup[0].cellSets[2].cells;
    expect(set2[0].value).toBe("18.143694800000002");
    expect(out.lastChanged).toBe("2026-07-22T02:01:06.000Z");
  });

  it("edits weight of the SECOND working set (skipping the rest-timer cellSet) and converts lb→kg", () => {
    const out = editSetCells(log(), [{ groupIndex: 0, setIndex: 1, weight: 135 }], deps) as any;
    const set2 = out._embedded.cellSetGroup[0].cellSets[2].cells;
    expect(Number(set2[0].value)).toBeCloseTo(135 * 0.45359237, 6);
    expect(set2[1].value).toBe("10"); // reps untouched
  });

  it("throws on an out-of-range set index", () => {
    expect(() => editSetCells(log(), [{ groupIndex: 0, setIndex: 5, reps: 1 }], deps)).toThrow(
      /range/i,
    );
  });

  it("throws on an out-of-range group index", () => {
    expect(() => editSetCells(log(), [{ groupIndex: 5, setIndex: 0, reps: 1 }], deps)).toThrow(
      /range/i,
    );
  });

  it("writes weight without conversion when weightUnit is KILOGRAMS", () => {
    const kgDeps = { clock, weightUnit: "KILOGRAMS" as const };
    const out = editSetCells(log(), [{ groupIndex: 0, setIndex: 0, weight: 100 }], kgDeps) as any;
    const weightCell = out._embedded.cellSetGroup[0].cellSets[0].cells.find(
      (c: any) => c.cellType === "BARBELL_WEIGHT",
    );
    expect(Number(weightCell.value)).toBe(100);
  });

  it("writes an rpe value onto the RPE cell", () => {
    const out = editSetCells(log(), [{ groupIndex: 0, setIndex: 0, rpe: 9 }], deps) as any;
    const rpeCell = out._embedded.cellSetGroup[0].cellSets[0].cells.find(
      (c: any) => c.cellType === "RPE",
    );
    expect(rpeCell.value).toBe("9");
  });

  it("does not mutate the input entity", () => {
    const input = log();
    const before = JSON.stringify(input);
    editSetCells(input, [{ groupIndex: 0, setIndex: 0, reps: 99 }], deps);
    expect(JSON.stringify(input)).toBe(before);
  });
});
