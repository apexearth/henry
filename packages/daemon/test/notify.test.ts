// bun test packages/daemon/test/notify.test.ts
// What a session's change of activity says to someone outside the window (src/notify.ts).
import { describe, expect, test } from "bun:test";
import type { Session } from "@henry/shared";
import { decide, MIN_WORKED_MS } from "../src/notify";

const T = 1_700_000_000_000;

const session = (activity: Session["activity"], activitySince = T, status: Session["status"] = "running"): Session => ({
  id: "s1",
  cwd: "/tmp/x",
  title: "rate limiter",
  createdAt: T - 60_000,
  status,
  activity,
  activitySince,
});

describe("decide", () => {
  test("a permission prompt is always news", () => {
    const n = decide({ activity: "working", activitySince: T }, session("needsInput", T + 1_000), T + 1_000);
    expect(n?.kind).toBe("needsInput");
    expect(n?.title).toBe("rate limiter");
    expect(n?.sessionId).toBe("s1");
  });

  test("a turn that worked long enough ending is news; a quick answer is not", () => {
    const long = decide({ activity: "working", activitySince: T }, session("waiting", T + MIN_WORKED_MS), T + MIN_WORKED_MS);
    expect(long?.kind).toBe("waiting");
    const quick = decide({ activity: "working", activitySince: T }, session("waiting", T + 2_000), T + 2_000);
    expect(quick).toBeUndefined();
  });

  test("waiting reached any other way says nothing", () => {
    // Startup, /clear, a resume: Claude is sitting at the prompt and nobody walked away.
    expect(decide({ activity: undefined }, session("waiting"), T)).toBeUndefined();
    expect(decide({ activity: "needsInput", activitySince: T - 60_000 }, session("waiting"), T)).toBeUndefined();
  });

  test("a first sighting, an unchanged state, ageing and exits are not transitions", () => {
    expect(decide(undefined, session("needsInput"), T)).toBeUndefined();
    expect(decide({ activity: "needsInput", activitySince: T }, session("needsInput"), T + 5_000)).toBeUndefined();
    expect(decide({ activity: "waiting", activitySince: T }, session("idle", T + 600_000), T + 600_000)).toBeUndefined();
    expect(decide({ activity: "working", activitySince: T }, session("needsInput", T + 60_000, "exited"), T + 60_000)).toBeUndefined();
  });

  test("a relayed session's notice carries its machine", () => {
    const n = decide({ activity: "working", activitySince: T }, { ...session("needsInput", T + 1_000), peer: "studio" }, T + 1_000);
    expect(n?.peer).toBe("studio");
  });
});
