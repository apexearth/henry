import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./ws";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

connect();
createRoot(document.getElementById("root")!).render(<App />);
