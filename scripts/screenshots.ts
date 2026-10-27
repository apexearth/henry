// Regenerate docs/screenshots from the UI's `?demo` mode (packages/ui/src/demo). Starts a
// private Vite server, drives the installed Chrome at it headless, saves one WebP per scene (and
// a GIF of the loom drifting, where ffmpeg is installed), and stops the server. Nothing touches
// the live daemon or ~/.henry.
//
//   bun scripts/screenshots.ts                        # every scene
//   bun scripts/screenshots.ts overview               # one
//   bun scripts/screenshots.ts backdrop-loom-motion   # the clip
import { mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Page } from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "screenshots");
const scenes = process.argv.slice(2);
const UI_PORT = 14799;
const DEMO_URL = `http://127.0.0.1:${UI_PORT}/?demo`;
const W = 1600, H = 1000;

const CHROME = process.env.CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "google-chrome");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
}

// Our own Vite, or nothing: a stray listener on the port would be what gets photographed.
if (await portOpen(UI_PORT)) {
  console.error(`something already listens on 127.0.0.1:${UI_PORT}; stop it first`);
  process.exit(1);
}
// Vite itself (not `bun run`, so kill() reaches it), on a dead daemon port on purpose: the demo
// answers every request in-page, so nothing is proxied.
const ui = path.join(root, "packages", "ui");
const vite = Bun.spawn(["bun", path.join(ui, "node_modules", ".bin", "vite"), "--strictPort"], {
  cwd: ui,
  env: { ...process.env, HENRY_UI_PORT: String(UI_PORT), HENRY_PORT: "14798" },
  stdout: "ignore",
  stderr: "inherit",
});
for (let i = 0; i < 100 && !(await portOpen(UI_PORT)); i++) await sleep(100);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // No WebGL: xterm's GL renderer ignores the device scale factor under software GL; the DOM renderer is exact.
  args: ["--hide-scrollbars", "--disable-webgl", "--disable-3d-apis"],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2 },
});

// Ctrl-C mid-run must not leave a headless Chrome and a Vite behind.
let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await browser.close().catch(() => {});
  vite.kill();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

// A fresh context per scene, so one scene's saved layout never leaks into the next.
let page: Page = null!;
async function fresh() {
  page = await (await browser.createBrowserContext()).newPage();
  page.on("pageerror", (e) => console.log("[page]", e.message));
}

/** Close a dock tab by its title. */
async function closeTab(title: string) {
  await page.evaluate((t) => {
    for (const tab of document.querySelectorAll<HTMLElement>(".dv-default-tab")) {
      if (tab.querySelector(".dv-default-tab-content")?.textContent?.trim() === t) tab.querySelector<HTMLElement>(".dv-default-tab-action")?.click();
    }
  }, title);
}

/** Bring a dock tab forward by its title (a "(2)" badge is ignored). */
async function clickTab(title: string) {
  await page.evaluate((t) => {
    for (const tab of document.querySelectorAll<HTMLElement>(".dv-default-tab")) {
      if (tab.querySelector(".dv-default-tab-content")?.textContent?.trim().replace(/ \(\d+\)$/, "") === t) tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    }
  }, title);
}

/** Drag the n-th vertical sash (left to right) by dx pixels. */
async function dragSash(index: number, dx: number) {
  const at = await page.evaluate((i) => {
    const r = [...document.querySelectorAll<HTMLElement>(".dv-sash")]
      .map((s) => s.getBoundingClientRect())
      .filter((r) => r.height > 100 && r.width < 10)
      .sort((a, b) => a.x - b.x)[i];
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, index);
  if (!at) return;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx / 2, at.y, { steps: 4 });
  await page.mouse.move(at.x + dx, at.y, { steps: 4 });
  await page.mouse.up();
}

/** Unfold folders in the files tree by name, in order (each click reveals the next). */
async function openFolders(names: string[]) {
  for (const n of names) {
    await page.evaluate((name) => {
      for (const row of document.querySelectorAll<HTMLElement>(".files-row")) if (row.textContent?.trim() === `▸${name}`) row.click();
    }, n);
    await sleep(150);
  }
}

/** Pick a rail row by its title. */
const railPick = (title: string) => page.evaluate((t) => {
  for (const row of document.querySelectorAll<HTMLElement>(".rail-item")) if (row.textContent?.includes(t)) return row.click();
}, title);

/** Theme choices, as the theme menu would set them (the demo keeps them in memory only). */
const theme = (choice: Record<string, string>) =>
  page.evaluate(async (c) => (await import("/src/theme.ts")).setTheme(c as never), choice);

/** A few seconds of the terminal pane as a GIF, for the backdrops that move. Needs ffmpeg; a
 * machine without it just skips the clip. */
async function clip(name: string, seconds: number, prep: () => Promise<void>) {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) return console.log(`skipped ${name}.gif: no ffmpeg`);
  await stage(prep);
  const box = await page.evaluate(() => {
    const r = document.querySelector(".term-sky")?.parentElement?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) return;
  const frames = path.join(out, `.${name}-frames`);
  mkdirSync(frames, { recursive: true });
  const fps = 10;
  for (let i = 0; i < seconds * fps; i++) {
    const t = Date.now();
    await page.screenshot({ path: path.join(frames, `${String(i).padStart(3, "0")}.png`), clip: box });
    await sleep(Math.max(0, 1000 / fps - (Date.now() - t)));
  }
  const file = path.join(out, `${name}.gif`);
  const enc = Bun.spawnSync([ffmpeg, "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(frames, "%03d.png"),
    "-vf", "scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", file]);
  rmSync(frames, { recursive: true, force: true });
  if (enc.exitCode) return console.log(`ffmpeg failed on ${name}.gif`);
  console.log("wrote", path.relative(root, file));
}


/** The default layout, adjusted the way a person would: no Voice pane, a rail wide enough for
 * titles, tools wide enough for the tree, and the session's src folder open. */
async function shot(name: string, prep?: () => Promise<void>) {
  await stage(prep);
  // WebP at 82 is a third of the PNG and reads the same at 2×; GitHub renders it inline.
  const file = path.join(out, `${name}.webp`);
  await page.screenshot({ path: file, type: "webp", quality: 82 });
  console.log("wrote", path.relative(root, file));
}

/** The page as `shot` photographs it, ready for a still or a clip. */
async function stage(prep?: () => Promise<void>) {
  await fresh();
  await page.goto(DEMO_URL, { waitUntil: "networkidle0" });
  await page.waitForSelector(".rail-item");
  await sleep(1200);
  await closeTab("Voice");
  await sleep(200);
  await dragSash(0, 70);
  await sleep(200);
  await dragSash(1, -60);
  await page.mouse.move(W / 2, H - 60); // off the sash, or it stays lit
  await sleep(400);
  await openFolders(["src", "middleware", "routes"]);
  await sleep(300);
  if (prep) await prep();
  await sleep(900);
}

const want = (s: string) => !scenes.length || scenes.includes(s);
mkdirSync(out, { recursive: true });

try {
  // The rate limiter session mid-turn, files tree beside it.
  if (want("overview")) await shot("overview");
  // The session that asked for you, its alarm flag open, every session's flags listed.
  if (want("flags")) await shot("flags", async () => {
    await railPick("terraform");
    await sleep(300);
    await clickTab("Flags");
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("label")].find((l) => l.textContent?.includes("all sessions"))?.querySelector("input")?.click());
    await sleep(300);
    await page.evaluate(() => {
      const pill = [...document.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === "alarm");
      (pill?.parentElement?.parentElement as HTMLElement | undefined)?.click(); // pill → head grid → row
    });
  });
  if (want("playbook")) await shot("playbook", () => clickTab("Playbook"));
  // Blocked on a permission prompt.
  if (want("needs")) await shot("needs", () => railPick("flaky e2e"));
  if (want("diff")) await shot("diff", () => page.evaluate(() => document.querySelector<HTMLElement>(".fr-diff")?.click()));
  // The backdrops. Life on the session whose window is fullest, so the board is busy and amber.
  if (want("backdrop-life")) await shot("backdrop-life", async () => {
    await railPick("terraform");
    await theme({ scene: "life", sky: "bold" });
    await sleep(3000);
  });
  // The loom on the rate limiter's three turns, glowing, then the same cloth drifting.
  const loom = async () => {
    await theme({ scene: "loom", sky: "bold", glow: "neon" });
    await sleep(3000);
  };
  if (want("backdrop-loom")) await shot("backdrop-loom", loom);
  if (want("backdrop-loom-motion")) await clip("backdrop-loom", 5, loom);
} finally {
  await shutdown();
}
