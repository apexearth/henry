// A render error anywhere used to unmount the whole app and leave a blank page, with nothing to
// say the sessions were fine. They are: the PTYs live in sessiond, so a reload always gets them
// back. This catches the throw, says so, and keeps the error on screen to read.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  err: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null, stack: "" };

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("[henry] render error", err, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  componentDidMount() {
    // In dev the usual cause is an HMR update that landed half an edit (a component rendered
    // before its file exists). The next save fixes it, so clear the error and let React retry
    // instead of making the user reload a window that is already correct.
    import.meta.hot?.on("vite:afterUpdate", () => this.setState({ err: null, stack: "" }));
  }

  render() {
    const { err, stack } = this.state;
    if (!err) return this.props.children;
    return (
      <div className="crash">
        <h3>the UI hit a render error</h3>
        <p>
          Your sessions are still running — they live in sessiond, not here. Reload to get the
          window back.
        </p>
        <pre>{String(err.stack || err)}{stack}</pre>
        <div className="row">
          <button onClick={() => location.reload()}>reload</button>
          <button onClick={() => this.setState({ err: null, stack: "" })}>try again</button>
        </div>
      </div>
    );
  }
}
