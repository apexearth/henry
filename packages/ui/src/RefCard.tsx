// The card behind `#157` in a terminal: which issue or PR that is, read from the session's GitHub
// repos and their projects (daemon/github.ts), without leaving Henry. Hovering opens it on a desk;
// a click or a tap pins it. When several repos have the number, the daemon asks a small model
// which one the text means, and the card lists the others underneath.
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { GithubItem, GithubRef } from "@henry/shared";

/** A mention under the pointer: the number, the terminal text around it, where it was. */
export interface RefAt {
  n: number;
  context: string;
  x: number;
  y: number;
}

export interface RefCardApi {
  hover(at: RefAt): void;
  leave(): void;
  pin(at: RefAt): void;
}

const OPEN_MS = 350;
const CLOSE_MS = 250;
const WIDTH = 380;

/** Answers this window already has, so hovering the same mention again is instant. */
const answers = new Map<string, GithubRef>();

async function load(sessionId: string, at: RefAt, pick: boolean): Promise<GithubRef> {
  const q = new URLSearchParams({ sessionId, n: String(at.n), context: at.context });
  if (pick) q.set("pick", "1");
  const res = await fetch(`/api/github/ref?${q}`);
  // A daemon from before these cards (often a peer's, which is the one this asks for a remote
  // session) has no such route.
  if (res.status === 404) throw new Error("the daemon running this session is older than these cards; update it and restart it");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The card for one terminal: an api for its link handlers, and the node to render. The card
 * goes into the terminal's own document, which for a popped-out group is another window. */
export function useRefCard(sessionId: string, box: RefObject<HTMLElement | null>) {
  const [card, setCard] = useState<{ at: RefAt; pinned: boolean } | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const api = useRef<RefCardApi & { keep(): void; close(): void }>(null!);
  if (!api.current) {
    const later = (fn: () => void, ms: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(fn, ms);
    };
    api.current = {
      hover(at) {
        // A touch screen has no hover; its tap arrives as a click and pins.
        if (cardRef.current?.pinned || !box.current?.ownerDocument.defaultView?.matchMedia("(hover: hover)").matches) return;
        later(() => setCard({ at, pinned: false }), cardRef.current ? 0 : OPEN_MS);
      },
      leave() {
        if (cardRef.current?.pinned) return;
        later(() => setCard(null), CLOSE_MS);
      },
      pin(at) {
        clearTimeout(timer.current);
        setCard({ at, pinned: true });
      },
      keep: () => clearTimeout(timer.current),
      close() {
        clearTimeout(timer.current);
        setCard(null);
      },
    };
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const doc = box.current?.ownerDocument;
  const node =
    card && doc
      ? createPortal(
          <>
            {card.pinned && <div className="pop-bg" onMouseDown={api.current.close} />}
            <Card key={`${card.at.n}\n${card.at.context}`} sessionId={sessionId} at={card.at} win={doc.defaultView ?? window} onEnter={api.current.keep} onLeave={card.pinned ? undefined : api.current.leave} onClose={api.current.close} />
          </>,
          doc.body,
        )
      : null;
  return { api: api.current as RefCardApi, node };
}

interface CardProps {
  sessionId: string;
  at: RefAt;
  win: Window;
  onEnter(): void;
  onLeave?(): void;
  onClose(): void;
}

function Card({ sessionId, at, win, onEnter, onLeave, onClose }: CardProps) {
  const key = `${sessionId}\n${at.n}\n${at.context}`;
  const [ref, setRef] = useState<GithubRef | null>(() => answers.get(key) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    let on = true;
    (async () => {
      try {
        let r = answers.get(key) ?? (await load(sessionId, at, false));
        if (!on) return;
        setRef(r);
        if (r.ambiguous) {
          setPicking(true);
          r = await load(sessionId, at, true);
          if (!on) return;
          setRef(r);
          setShown(0);
        }
        answers.set(key, r);
      } catch (e) {
        if (on) setErr((e as Error).message);
      } finally {
        if (on) setPicking(false);
      }
    })();
    return () => void (on = false);
  }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }, [win, onClose]);

  const left = Math.max(8, Math.min(at.x - 24, win.innerWidth - WIDTH - 8));
  const below = at.y < win.innerHeight * 0.55;
  const style = below ? { left, top: at.y + 16 } : { left, bottom: win.innerHeight - at.y + 8 };
  const items = ref?.items ?? [];
  const item = items[shown];

  return (
    <div className="ref-card" style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {err ? (
        <div className="ref-note">#{at.n}: {err}</div>
      ) : !ref ? (
        <div className="ref-note">looking up #{at.n}…</div>
      ) : !item ? (
        <div className="ref-note">{ref.note ?? `nothing numbered #${at.n}`}</div>
      ) : (
        <>
          <Item it={item} />
          {items.length > 1 && (
            <div className="ref-others">
              <div className="ref-note">
                {picking
                  ? `${items.length} repos have a #${at.n}; asking the model which one this is…`
                  : ref.pick === "model"
                    ? `${items.length} repos have a #${at.n}; from the text around it, the model picked ${shown ? items[0]!.repo : "this one"}`
                    : `${items.length} repos have a #${at.n}; ${ref.note ?? "showing the session's own repo first"}`}
              </div>
              {items.map((it, i) =>
                i === shown ? null : (
                  <button key={it.repo} className="ref-alt" onClick={() => setShown(i)}>
                    <span className={"ref-state " + it.state}>{it.state}</span> {it.repo.split("/")[1]}#{it.number} {it.title}
                  </button>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Item({ it }: { it: GithubItem }) {
  const meta = [it.labels.join(", "), it.assignees.map((a) => "@" + a).join(" ")].filter(Boolean).join(" · ");
  return (
    <>
      <div className="ref-head">
        <span className={"ref-state " + it.state}>{it.state}</span>
        <span>
          {it.repo}#{it.number}
          {it.kind === "pr" ? " · pull request" : ""}
        </span>
      </div>
      <div className="ref-title">{it.title}</div>
      {it.fields.length > 0 && (
        <div className="ref-fields" title={it.project}>
          {it.fields.map((f) => (
            <span key={f.name} className="ref-field">
              <span className="k">{f.name}</span> {f.value}
            </span>
          ))}
        </div>
      )}
      {meta && <div className="ref-meta">{meta}</div>}
      {it.body && <div className="ref-body">{it.body}</div>}
      <div className="ref-foot">
        <span>{it.project ?? ""}</span>
        <a href={it.url} target="_blank" rel="noopener">
          open on GitHub ↗
        </a>
      </div>
    </>
  );
}
