// A QR as one SVG path: every dark module a rectangle in the same `d`, so a 40×40 code is one
// element rather than sixteen hundred. Light on dark like the rest of Henry would not scan on
// every reader, so the code keeps its own white ground whatever the theme is.
import { qrMatrix } from "@henry/shared";

export function Qr({ text, size = 220, quiet = 3 }: { text: string; size?: number; quiet?: number }) {
  let modules: boolean[][];
  try {
    modules = qrMatrix(text);
  } catch {
    return <div className="err">that address is too long for a QR code</div>;
  }
  const side = modules.length + quiet * 2;
  let d = "";
  for (let r = 0; r < modules.length; r++) {
    for (let c = 0; c < modules.length; c++) {
      if (modules[r]![c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" role="img" aria-label="pairing code">
      <rect width={side} height={side} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
