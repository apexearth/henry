// A markdown file as a page: marked → DOMPurify → HTML, then three passes over the mounted
// DOM. Fenced code is coloured once its language has loaded, ```mermaid fences become SVG
// (mermaid is two megabytes, so it is imported only when a file has one), and relative
// images are fetched through the same peek endpoint as the file, so a relayed session's
// README shows its screenshots too.
import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { highlightBlock } from "./highlight";
import { cssVar, useTheme } from "./theme";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** GitHub's heading anchors, so `[…](#install)` links inside a file keep working. */
function slug(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// Parsing is synchronous, so one slug table reset per parse serves every file.
let seen = new Map<string, number>();
const md = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth, text }: Tokens.Heading) {
      return `<h${depth} id="${slug(text, seen)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    code({ text, lang }: Tokens.Code) {
      const name = (lang ?? "").trim().split(/\s+/)[0];
      if (name === "mermaid") return `<pre class="md-mermaid">${escapeHtml(text)}</pre>\n`;
      return `<pre><code${name ? ` data-lang="${escapeHtml(name)}"` : ""}>${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

function toHtml(text: string): string {
  seen = new Map();
  return DOMPurify.sanitize(md.parse(text, { async: false }), { USE_PROFILES: { html: true }, ADD_ATTR: ["data-lang"] });
}

/** A URL the file's own folder resolves: not a scheme, not site-absolute, not an anchor. */
const isRelative = (u: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);

let seq = 0;

interface Props {
  text: string;
  /** Relative `src` → a data URL, or null when there is no such file. */
  loadImage: (src: string) => Promise<string | null>;
  /** A relative link was clicked: open that file. */
  openLink: (href: string) => void;
}

export function Markdown({ text, loadImage, openLink }: Props) {
  const html = useMemo(() => toHtml(text), [text]);
  const root = useRef<HTMLDivElement>(null);
  const theme = useTheme();

  // Fenced code: the block is shown plain at once and coloured when its language arrives.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let on = true;
    for (const code of el.querySelectorAll<HTMLElement>("pre > code[data-lang]")) {
      const src = code.textContent ?? "";
      highlightBlock(code.dataset.lang ?? "", src).then((h) => {
        if (on && h !== null && code.textContent === src) code.innerHTML = h;
      });
    }
    return () => {
      on = false;
    };
  }, [html]);

  // Diagrams, drawn in the app's own colours; redrawn when those change.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>("pre.md-mermaid, .md-diagram")];
    if (!nodes.length) return;
    let on = true;
    import("mermaid").then(async ({ default: mermaid }) => {
      if (!on) return;
      const fg = cssVar("--fg"), dim = cssVar("--fg-dim"), bg = cssVar("--bg-2"), bg3 = cssVar("--bg-3"), border = cssVar("--border"), accent = cssVar("--accent");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: cssVar("--mono"),
        themeVariables: {
          darkMode: true, background: bg, fontSize: "13px",
          primaryColor: bg3, primaryTextColor: fg, primaryBorderColor: accent,
          secondaryColor: bg3, secondaryTextColor: fg, secondaryBorderColor: border,
          tertiaryColor: bg, tertiaryTextColor: fg, tertiaryBorderColor: border,
          lineColor: dim, textColor: fg, mainBkg: bg3, nodeBorder: accent, nodeTextColor: fg,
          clusterBkg: bg, clusterBorder: border, titleColor: fg, edgeLabelBackground: bg,
          noteBkgColor: bg3, noteTextColor: fg, noteBorderColor: border,
          actorBkg: bg3, actorBorder: accent, actorTextColor: fg, actorLineColor: dim,
          signalColor: fg, signalTextColor: fg, labelBoxBkgColor: bg3, labelTextColor: fg, loopTextColor: fg,
          activationBkgColor: bg3, activationBorderColor: accent, sequenceNumberColor: bg,
          pie1: accent, pieTitleTextColor: fg, pieSectionTextColor: fg, pieLegendTextColor: fg, pieStrokeColor: border,
          git0: accent, gitBranchLabel0: bg, commitLabelColor: fg, commitLabelBackground: bg3, tagLabelColor: fg, tagLabelBackground: bg3, tagLabelBorder: border,
        },
      });
      for (const n of nodes) {
        const src = n.dataset.src ?? n.textContent ?? "";
        let box: HTMLElement;
        try {
          const { svg } = await mermaid.render(`md-diagram-${++seq}`, src);
          if (!on) return;
          box = document.createElement("div");
          box.className = "md-diagram";
          box.innerHTML = svg;
        } catch (e) {
          if (!on) return;
          // The diagram's own words, then the source, so a typo can be found.
          box = document.createElement("div");
          box.className = "md-diagram err";
          const msg = document.createElement("div");
          msg.className = "md-diagram-err";
          msg.textContent = (e instanceof Error ? e.message : String(e)).split("\n")[0];
          const pre = document.createElement("pre");
          pre.textContent = src;
          box.append(msg, pre);
        }
        box.dataset.src = src;
        n.replaceWith(box);
      }
    });
    return () => {
      on = false;
    };
  }, [html, theme]);

  // Pictures beside the file. Left as the alt text when there is no such file.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let on = true;
    for (const img of el.querySelectorAll<HTMLImageElement>("img[src]")) {
      const src = img.getAttribute("src") ?? "";
      if (!isRelative(src)) continue;
      img.removeAttribute("src");
      loadImage(src).then((url) => on && url && img.setAttribute("src", url));
    }
    return () => {
      on = false;
    };
  }, [html, loadImage]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    if (href.startsWith("#")) root.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: "start" });
    else if (isRelative(href)) openLink(href);
    else window.open(href, "_blank", "noopener");
  };

  return <div className="md" ref={root} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
