// Fuzzy path matching, shared by the files pane and ⌘K. Was copied verbatim between the two
// pickers; one copy now, since they must rank the same way or the same query means two things.

/** Subsequence match; rewards word starts, runs, and hits in the last segment. -Infinity: no match. */
export function score(q: string, path: string): number {
  const s = path.toLowerCase();
  let qi = 0;
  let first = -1;
  let last = -2;
  let bonus = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    if (first < 0) first = i;
    if (last === i - 1) bonus += 2;
    const prev = s[i - 1];
    if (i === 0 || prev === "/" || prev === "." || prev === "_" || prev === "-") bonus += 3;
    last = i;
    qi++;
  }
  if (qi < q.length) return -Infinity;
  const name = s.slice(s.lastIndexOf("/") + 1);
  if (name.startsWith(q)) bonus += 12;
  else if (name.includes(q)) bonus += 8;
  return bonus - (last - first - q.length) * 0.2 - s.length * 0.005;
}

/** Every token must match; the scores add. */
export function matches(tokens: string[], path: string): number {
  let total = 0;
  for (const t of tokens) {
    const sc = score(t, path);
    if (sc === -Infinity) return -Infinity;
    total += sc;
  }
  return total;
}

/** A query into the tokens `matches` wants. */
export function tokenize(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The glob box: `*.ts,*.tsx` keeps only those, a `!` prefix excludes. Same vocabulary the
 * daemon turns into `git grep` pathspecs, so the tree and the text search agree on what is
 * in scope. Matching is on the whole relative path, and `*` crosses `/` — as git's pathspec
 * globbing does, so `*.ts` means "any .ts anywhere", which is what you expect when you type it.
 */
export function globFilter(glob: string): ((rel: string) => boolean) | undefined {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const raw of glob.split(",")) {
    const g = raw.trim();
    if (!g) continue;
    const neg = g.startsWith("!");
    const re = globToRegExp(neg ? g.slice(1) : g);
    if (re) (neg ? exclude : include).push(re);
  }
  if (!include.length && !exclude.length) return undefined;
  return (rel: string) => {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const hit = (re: RegExp) => re.test(rel) || re.test(name);
    if (exclude.some(hit)) return false;
    return !include.length || include.some(hit);
  };
}

function globToRegExp(g: string): RegExp | undefined {
  if (!g) return undefined;
  let out = "";
  for (const ch of g) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${out}$`, "i");
  } catch {
    return undefined;
  }
}
