import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
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
connect();
startPresence();
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
