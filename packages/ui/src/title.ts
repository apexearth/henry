// The one thing worth saying from outside the window: a session asked for you by name. Both
// shapes of the UI set it, so the phone's tab strip carries the ask the same way the desktop's
// window title does.
import { useEffect } from "react";
import { useStore } from "./ws";

export function useAskTitle(): void {
  const asks = useStore((s) => s.attention);
  useEffect(() => {
    document.title = asks.length ? `❗ Henry — ${asks[0]!.message.slice(0, 60)}` : "Henry";
  }, [asks]);
}
