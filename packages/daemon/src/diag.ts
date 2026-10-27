// What the daemon is holding, for chasing memory growth on a live daemon without guessing:
// process and JSC heap numbers, the top object types, and the size of every long-lived
// collection a module keeps. `GET /api/debug/memory` serves it; `POST /api/debug/heap-snapshot`
// writes a Chrome-loadable snapshot into the Henry home. Loopback only (server.ts refuses peers
// and phones): a snapshot holds every string in the heap, tokens and transcripts included.
import { generateHeapSnapshot } from "bun";
import * as jsc from "bun:jsc";
import { heapStats, startSamplingProfiler } from "bun:jsc";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as activity from "./activity";
import * as attention from "./attention";
import { henryDir } from "./config";
import * as engagement from "./engagement";
import * as federation from "./federation";
import * as files from "./files";
import * as filewatch from "./filewatch";
import * as git from "./git";
import { screens } from "./screen";
import { sessions } from "./sessions";
import * as transcript from "./transcript";

const startedAt = Date.now();
const mb = (n: number) => Math.round(n / 104857.6) / 10;

export function memoryReport(extra: Record<string, number> = {}): Record<string, unknown> {
  const m = process.memoryUsage();
  const h = heapStats();
  const top = Object.entries(h.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    bun: Bun.version,
    process: { rssMb: mb(m.rss), heapTotalMb: mb(m.heapTotal), heapUsedMb: mb(m.heapUsed), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) },
    jsc: {
      heapSizeMb: mb(h.heapSize),
      heapCapacityMb: mb(h.heapCapacity),
      extraMemoryMb: mb(h.extraMemorySize),
      objectCount: h.objectCount,
      protectedObjectCount: h.protectedObjectCount,
      globalObjectCount: h.globalObjectCount,
    },
    topObjectTypes: Object.fromEntries(top),
    held: {
      ...sessions.stats(),
      ...screens.stats(),
      ...transcript.stats(),
      ...git.stats(),
      ...files.stats(),
      ...filewatch.stats(),
      ...federation.stats(),
      ...attention.stats(),
      ...engagement.stats(),
      ...activity.stats(),
      ...extra,
    },
  };
}

/** Chrome DevTools > Memory > Load reads the file. */
export function writeHeapSnapshot(): { path: string; bytes: number } {
  const snap = generateHeapSnapshot("v8") as unknown;
  const text = typeof snap === "string" ? snap : JSON.stringify(snap);
  const path = join(henryDir, `heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`);
  writeFileSync(path, text);
  return { path, bytes: text.length };
}

let sampling = false;
type Frame = { name: string; sourceURL?: string; line?: number };
/** Not in bun-types: the raw samples since the last call, which this call clears. */
const traces = () => (jsc as unknown as { samplingProfilerStackTraces(): { traces: { frames: Frame[] }[] } }).samplingProfilerStackTraces();

/**
 * Where the daemon's time goes, for a daemon that feels slow: JSC's sampling profiler over
 * `seconds`, folded into the functions on top of the stack (self) and anywhere on it (total),
 * by samples of 1 ms. A synchronous SQLite or fs call counts against the JS function making it.
 * JSC has no way to stop the sampler once started, so it runs (a few percent) until the
 * daemon restarts; the first call says so.
 */
export async function profile(seconds: number): Promise<Record<string, unknown>> {
  const first = !sampling;
  if (first) startSamplingProfiler();
  sampling = true;
  traces(); // what built up before this window
  await Bun.sleep(Math.min(Math.max(seconds, 1), 120) * 1000);
  const { traces: samples } = traces();
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const label = (f: Frame) =>
    `${f.name || "(anonymous)"} ${f.sourceURL ? f.sourceURL.split(/[\\/]/).slice(-2).join("/") : "(native)"}${f.line ? `:${f.line}` : ""}`;
  let busy = 0;
  for (const t of samples) {
    if (!t.frames.length) continue;
    busy++;
    const top = label(t.frames[0]);
    self.set(top, (self.get(top) ?? 0) + 1);
    for (const l of new Set(t.frames.map(label))) total.set(l, (total.get(l) ?? 0) + 1);
  }
  const rank = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, samples]) => ({ fn, samples }));
  return { seconds, samples: samples.length, busy, note: first ? "sampling stays on until the daemon restarts" : undefined, self: rank(self, 30), total: rank(total, 50) };
}

/** A full collection first, so what is reported is what is retained, not what is garbage. */
export function collectGarbage(): void {
  Bun.gc(true);
}
