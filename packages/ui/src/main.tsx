import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./ws";
import { applyTheme } from "./theme";
import "@xterm/xterm/css/xterm.css";
import "dockview-react/dist/styles/dockview.css";
import "./styles.css";

applyTheme();
connect();
createRoot(document.getElementById("root")!).render(<App />);
