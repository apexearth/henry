#!/usr/bin/env bun
// henry CLI: start (default) | install | uninstall | status | sessiond status|restart [--now]
const cmd = process.argv[2] ?? "start";

async function main(): Promise<void> {
  switch (cmd) {
    case "start": {
      const { startServer, stopServer } = await import("./server");
      await startServer();
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
    case "sessiond": {
      const sub = process.argv[3];
      const sessiond = await import("./sessiond-cli");
      if (sub === "status") await sessiond.status();
      else if (sub === "restart") await sessiond.restart(process.argv.includes("--now"));
      else {
        console.error("usage: henry sessiond status | restart [--now]");
        process.exit(2);
      }
      return;
    }
    case "-h":
    case "--help":
    case "help":
      console.log("usage: henry [start|install|uninstall|status|sessiond status|sessiond restart [--now]]");
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
