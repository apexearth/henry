// `henry sessiond status | restart [--now]`. Talks to sessiond directly; never starts one.
import { henryDir } from "./config";
import { PROTOCOL_VERSION, SessiondClient, pidAlive, readSessiondInfo } from "./sessiond-client";

export async function status(): Promise<void> {
  const info = readSessiondInfo(henryDir);
  console.log(`sessiond.json: ${henryDir}/sessiond.json${info ? "" : " (missing or unreadable)"}`);
  console.log(`daemon expects protocol ${PROTOCOL_VERSION}`);
  if (!info) return;
  console.log(`  pid ${info.pid} (${pidAlive(info.pid) ? "alive" : "DEAD"}), port ${info.port}, protocol ${info.protocolVersion}, started ${new Date(info.startedAt).toLocaleString()}`);
  const client = new SessiondClient({ henryDir, autoStart: false, reconnect: false, log: () => {} });
  try {
    const sessions = await client.connect();
    const pong = await client.ping();
    const running = sessions.filter((s) => s.status === "running").length;
    console.log(`answers: ${pong ? "yes (pong)" : "hello ok, no pong"}; protocol ${client.remoteProtocolVersion}${client.remoteProtocolVersion === PROTOCOL_VERSION ? "" : " (MISMATCH: run `henry sessiond restart`)"}`);
    console.log(`sessions: ${running} running, ${sessions.length - running} exited (retained)`);
    for (const s of sessions) console.log(`  ${s.id.slice(0, 8)} ${s.status.padEnd(7)} pid ${String(s.pid).padEnd(6)} ${s.command} ${s.args.join(" ")}  (${s.cwd})`);
  } catch (e) {
    console.log(`answers: no (${(e as Error).message})`);
  } finally {
    client.close();
  }
}

export async function restart(now: boolean): Promise<void> {
  const info = readSessiondInfo(henryDir);
  if (!info) {
    console.log(`no sessiond.json in ${henryDir}; nothing to restart (the daemon starts one on demand)`);
    return;
  }
  const client = new SessiondClient({ henryDir, autoStart: false, reconnect: false, log: () => {} });
  try {
    const sessions = await client.connect();
    const running = sessions.filter((s) => s.status === "running").length;
    client.send({ op: "shutdown", when: now ? "now" : "idle" });
    await new Promise((r) => setTimeout(r, 100));
    if (now) console.log(`sessiond pid ${info.pid}: hanging up ${running} running session(s) and exiting`);
    else if (running === 0) console.log(`sessiond pid ${info.pid}: no running sessions; exiting now`);
    else console.log(`sessiond pid ${info.pid}: will exit once its ${running} running session(s) end`);
    console.log("the daemon spawns a fresh sessiond on its next connect");
  } catch (e) {
    console.log(`sessiond pid ${info.pid} did not answer (${(e as Error).message})${pidAlive(info.pid) ? "" : "; it is not running"}`);
  } finally {
    client.close();
  }
}
