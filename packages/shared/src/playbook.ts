// The overseer writes playbook text in a small labeled shape (see SYSTEM_PROMPT in
// packages/daemon/src/overseer.ts) so the panel can render it at a glance:
//   HEADLINE: one line
//   DOING: one line
//   CHANGED:
//   - bullet
//   CAREFUL: none
// Labels are free-form upper-case words; the parser keeps the order it sees. Text with no
// labels (older entries, an off-script reply) comes back as a single unlabeled prose section.

export interface PlaybookSection {
  /** Upper-case label as written ("DOING", "CAREFUL"…); "" for unlabeled prose. */
  label: string;
  /** Text on the label line itself, if any. */
  text?: string;
  /** Bullet lines under the label. */
  items: string[];
}

export interface ParsedPlaybook {
  headline?: string;
  sections: PlaybookSection[];
}

const LABEL = /^\s*(?:\*\*|#+\s*)?([A-Z][A-Z ]{1,24}?)\**:\**\s*(.*)$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const NONE = /^\(?\s*(none|nothing|n\/a|no change|-)\s*\)?\.?$/i;

const unwrap = (s: string) => s.replace(/^\*\*(.*)\*\*$/, "$1").trim();

export function parsePlaybookText(raw: string): ParsedPlaybook {
  const lines = raw.replace(/\r/g, "").split("\n");
  const sections: PlaybookSection[] = [];
  let cur: PlaybookSection | undefined;
  let sawLabel = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const l = LABEL.exec(line);
    if (l) {
      sawLabel = true;
      cur = { label: l[1].trim(), text: unwrap(l[2]) || undefined, items: [] };
      sections.push(cur);
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      if (!cur) {
        cur = { label: "", items: [] };
        sections.push(cur);
      }
      cur.items.push(unwrap(b[1]));
      continue;
    }
    // Continuation: extend the last bullet, else the label's own text, else start prose.
    const t = line.trim();
    if (cur?.items.length) cur.items[cur.items.length - 1] += " " + t;
    else if (cur) cur.text = cur.text ? cur.text + " " + t : t;
    else {
      cur = { label: "", text: t, items: [] };
      sections.push(cur);
    }
  }

  if (!sawLabel) {
    const text = raw.trim();
    return { sections: text ? [{ label: "", text, items: [] }] : [] };
  }

  let headline: string | undefined;
  const kept: PlaybookSection[] = [];
  for (const s of sections) {
    const items = s.items.filter((i) => !NONE.test(i));
    const text = s.text && !NONE.test(s.text) ? s.text : undefined;
    if (s.label === "HEADLINE" && headline === undefined) {
      headline = [text, ...items].filter(Boolean).join(" ") || undefined;
      continue;
    }
    if (!text && !items.length) continue;
    kept.push({ label: s.label, text, items });
  }
  return { headline, sections: kept };
}
