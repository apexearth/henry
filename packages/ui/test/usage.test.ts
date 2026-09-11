import { describe, expect, test } from "bun:test";
import type { Usage } from "@henry/shared";
import { hostRows } from "../src/panels/Usage";

const base: Usage = { perSession: {}, updatedAt: 7 };

describe("hostRows", () => {
  test("a daemon from before per-host windows has one machine: this one", () => {
    const rows = hostRows({ ...base, fiveHour: { utilization: 0.4 } }, "mac");
    expect(rows).toEqual([{ name: "mac", peer: false, usage: { fiveHour: { utilization: 0.4 }, sevenDay: undefined, updatedAt: 7 } }]);
  });

  test("this machine leads, peers follow by name, and only peers are coloured as peers", () => {
    const rows = hostRows(
      {
        ...base,
        hosts: { zed: { updatedAt: 3 }, mac: { fiveHour: { utilization: 0.2 }, updatedAt: 7 }, box: { updatedAt: 5 } },
      },
      "mac",
    );
    expect(rows.map((r) => [r.name, r.peer])).toEqual([
      ["mac", false],
      ["box", true],
      ["zed", true],
    ]);
    expect(rows[0]!.usage.fiveHour?.utilization).toBe(0.2);
  });

  test("a daemon that has not named itself still lists the machines it knows", () => {
    const rows = hostRows({ ...base, hosts: { beta: { updatedAt: 1 } } }, null);
    expect(rows.map((r) => [r.name, r.peer])).toEqual([["beta", true]]);
  });
});
