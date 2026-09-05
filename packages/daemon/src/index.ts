#!/usr/bin/env bun
// henry CLI: start (default) | install | uninstall | status | sessiond status|restart [--now]
//            | pair | peers [forget <name> | url <name> <host[:port]|->]
//            | phone [invite | forget <name>]
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
    case "pair":
    case "peers": {
      const fed = await import("./federation-cli");
      if (cmd === "pair") await fed.pair();
      else if (process.argv[3] === "forget" && process.argv[4]) await fed.forget(process.argv[4]);
      else if (process.argv[3] === "url" && process.argv[4] && process.argv[5]) await fed.setUrl(process.argv[4], process.argv[5]);
      else if (process.argv[3]) {
        console.error("usage: henry peers [forget <name> | url <name> <host[:port]|->]");
        process.exit(2);
      } else await fed.peers();
      return;
    }
    case "phone": {
      const p = await import("./phone-cli");
      const sub = process.argv[3];
      if (!sub) await p.status();
      else if (sub === "invite") await p.invite();
      else if (sub === "forget" && process.argv[4]) await p.forget(process.argv[4]);
      else {
        console.error("usage: henry phone [invite | forget <name>]");
        process.exit(2);
      }
      return;
    }
    case "-h":
    case "--help":
    case "help":
      console.log("usage: henry [start|install|uninstall|status|sessiond status|sessiond restart [--now]|pair|peers [forget <name> | url <name> <host[:port]|->]|phone [invite|forget <name>]]");
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
