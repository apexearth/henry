import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./ws";
import { applyTheme } from "./theme";
import { isMac } from "./platform";
import "@xterm/xterm/css/xterm.css";
import "dockview-react/dist/styles/dockview.css";
import "./styles.css";

// styles.css keeps macOS's overlay scrollbars and draws its own slim ones everywhere else.
document.documentElement.dataset.platform = isMac ? "mac" : "other";
applyTheme();
connect();
createRoot(document.getElementById("root")!).render(<App />);
