// What a phone sees when it is not (or no longer) allowed in: how to get a QR, and nothing
// else. There is no form here on purpose — access is granted by scanning, not by typing a
// secret into a page that anyone on the network can load.
import { HenryMark } from "../HenryMark";

export function Gate({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return (
    <div className="m-gate">
      <HenryMark />
      <h2>henry</h2>
      <p className="err">{error ?? "this device has not been granted access"}</p>
      <ol>
        <li>Open Henry on your computer.</li>
        <li>Press <b>phone</b> in the top bar, then <b>show a QR code</b>.</li>
        <li>Scan it with this phone's camera.</li>
      </ol>
      <p className="dim">The computer and this phone have to be on the same tailnet.</p>
      <button onClick={onRetry}>try again</button>
    </div>
  );
}
