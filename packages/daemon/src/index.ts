#!/usr/bin/env bun
// henry CLI: start (default) | install | uninstall | status
const cmd = process.argv[2] ?? "start";

async function main(): Promise<void> {
  switch (cmd) {
    case "start": {
      const { startServer, stopServer } = await import("./server");
      startServer();
      const stop = () => {
        stopServer();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "install":
    case "uninstall":
    case "status": {
      const installer = await import("./installer");
      await installer[cmd]();
      return;
    }
    case "-h":
    case "--help":
    case "help":
      console.log("usage: henry [start|install|uninstall|status]");
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
