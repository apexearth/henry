// Who may talk to a listener at all, decided before any routing.
//
// Loopback is not a boundary against the browser. Any page on any site can open a WebSocket
// to 127.0.0.1 and send a text/plain POST there with no preflight, and a page whose name was
// rebound to 127.0.0.1 is same-origin with the daemon and reads its answers. So a request that
// carries an Origin must come from the page the listener itself serves (the Vite dev proxy
// passes the Host through, so its page counts), and on loopback the Host must be a loopback
// name. Hooks, the CLI and MCP clients send no Origin and are let through.
//
// A page shown by an HTML peek (files.serveRaw) is sandboxed into an opaque origin and says
// `Origin: null`. It may load the files beside it and nothing else.

// Browsers resolve *.localhost to loopback themselves, never through DNS, so no rebound name
// can end in it.
const loopbackName = (host: string): boolean => {
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.replace(/\.$/, "");
  } catch {
    return false;
  }
  return name === "127.0.0.1" || name === "[::1]" || name === "localhost" || name.endsWith(".localhost");
};

/** Why the request is refused, or undefined to let it through. `raw` is a /raw/ path. */
export function refusal(req: Request, loopback: boolean, raw: boolean): string | undefined {
  const host = req.headers.get("host") ?? "";
  if (loopback && !loopbackName(host)) return "foreign host";
  const origin = req.headers.get("origin");
  if (origin === null) return undefined;
  if (origin === "null") return raw ? undefined : "sandboxed page";
  try {
    const from = new URL(origin);
    return new URL(`${from.protocol}//${host}`).host === from.host ? undefined : "foreign origin";
  } catch {
    return "foreign origin";
  }
}
