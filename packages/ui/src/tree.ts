// Flat path lists into a folder tree, and the filtering that keeps a match's ancestors.
// Pure: no React, no fetching, so it is the one part of the files pane that is unit tested.

export interface TreeNode {
  /** Path relative to the root, forward slashes. Directories have no trailing slash. */
  rel: string;
  /** The label: the last segment, or several when a single-child chain was collapsed. */
  name: string;
  dir: boolean;
  children: TreeNode[];
}

interface Building {
  name: string;
  children: Map<string, Building>;
  isFile: boolean;
  /** Named as a folder in its own right (`dirs`): shown even with nothing listed in it. */
  isDir?: boolean;
}

/**
 * Nest flat relative paths. Directories sort before files, then by name, case-insensitively.
 *
 * A directory with exactly one child directory and nothing else is collapsed into it
 * ("packages/ui/src" on one row), which is the difference between a readable tree and eight
 * rows of scaffolding in a 220px rail. Collapsing stops at anything that forks.
 *
 * `dirs` are folders shown whether or not anything under them is listed: a git-ignored folder,
 * whose contents are read only when it is opened. They never take part in a collapse, so the
 * row you opened keeps its key once its contents arrive.
 */
export function buildTree(paths: string[], dirs: Iterable<string> = []): TreeNode[] {
  const root: Building = { name: "", children: new Map(), isFile: false };
  const add = (p: string, dir: boolean) => {
    const parts = p.split("/").filter(Boolean);
    if (!parts.length) return;
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      let next = node.children.get(seg);
      if (!next) node.children.set(seg, (next = { name: seg, children: new Map(), isFile: false }));
      if (i === parts.length - 1) {
        if (dir) next.isDir = true;
        else next.isFile = true;
      }
      node = next;
    }
  };
  for (const p of paths) add(p, false);
  for (const d of dirs) add(d, true);
  return finish(root, "");
}

function finish(node: Building, prefix: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const child of node.children.values()) {
    const rel = prefix ? `${prefix}/${child.name}` : child.name;
    // A leaf that was never marked a file is an empty directory; it has nothing to show,
    // unless it was named as a folder.
    if (child.isFile && !child.children.size && !child.isDir) {
      out.push({ rel, name: child.name, dir: false, children: [] });
      continue;
    }
    if (!child.children.size && !child.isDir) continue;
    let label = child.name;
    let here = child;
    let hereRel = rel;
    // Collapse single-child directory chains: one row, one path.
    while (here.children.size === 1 && !here.isFile && !here.isDir) {
      const only = [...here.children.values()][0];
      if (only.isFile && !only.children.size) break;
      if (!only.children.size || only.isDir) break;
      label += `/${only.name}`;
      hereRel = `${hereRel}/${only.name}`;
      here = only;
    }
    out.push({ rel: hereRel, name: label, dir: true, children: finish(here, hereRel) });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
  return out;
}

/** Every directory `rel` on the way to each path, so a filtered tree can open itself. */
export function ancestorsOf(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    let at = p.lastIndexOf("/");
    while (at > 0) {
      out.add(p.slice(0, at));
      at = p.lastIndexOf("/", at - 1);
    }
  }
  return out;
}

/** Depth-first file paths of a subtree, for "open everything under here". */
export function filesUnder(nodes: TreeNode[], into: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) filesUnder(n.children, into);
    else into.push(n.rel);
  }
  return into;
}
