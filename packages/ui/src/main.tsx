import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { checkAccess, type Access } from "./access";
import { connect } from "./ws";
import { startPresence } from "./presence";
import { applyTheme } from "./theme";
import { isMac } from "./platform";
import "@xterm/xterm/css/xterm.css";
import "dockview-react/dist/styles/dockview.css";
import "./styles.css";

// styles.css keeps macOS's overlay scrollbars and draws its own slim ones everywhere else.
document.documentElement.dataset.platform = isMac ? "mac" : "other";
applyTheme();

const root = createRoot(document.getElementById("root")!);

// Ask first, connect second. On the daemon's own machine this is one loopback request that
// says "nobody had to be let in"; on a phone it is where the QR's invite is spent for a token,
// and connecting before that has happened would only be a WebSocket bouncing off a 401.
let started = false;
async function boot(): Promise<void> {
  const access: Access = await checkAccess();
  if (access.ok && !started) {
    started = true;
    connect();
    startPresence();
  }
  root.render(
    <ErrorBoundary>
      <App access={access} onRetry={() => void boot()} />
    </ErrorBoundary>,
  );
}

void boot();
