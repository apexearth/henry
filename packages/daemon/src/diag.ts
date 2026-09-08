// What the daemon is holding, for chasing memory growth on a live daemon without guessing:
// process and JSC heap numbers, the top object types, and the size of every long-lived
// collection a module keeps. `GET /api/debug/memory` serves it; `POST /api/debug/heap-snapshot`
// writes a Chrome-loadable snapshot into the Henry home. Loopback only (server.ts refuses peers
// and phones): a snapshot holds every string in the heap, tokens and transcripts included.
import { generateHeapSnapshot } from "bun";
import { heapStats } from "bun:jsc";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as activity from "./activity";
import * as attention from "./attention";
import { henryDir } from "./config";
import * as engagement from "./engagement";
import * as federation from "./federation";
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

/** A full collection first, so what is reported is what is retained, not what is garbage. */
export function collectGarbage(): void {
  Bun.gc(true);
}
