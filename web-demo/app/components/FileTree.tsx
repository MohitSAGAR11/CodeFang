import { ChevronRight, File, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import type { Playground } from "../state/usePlayground.ts";
import type { StagedGroup } from "../lib/types.ts";

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  isFile: boolean;
}

function buildTree(paths: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map(), isFile: false };
  for (const p of paths) {
    let node = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), isFile };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

const sortNodes = (a: Node, b: Node) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1);

const CHANGE_LETTER = { created: "A", modified: "M", deleted: "D", folder: "+" } as const;
const CHANGE_WORD = { created: "staged: new file", modified: "staged: modified", deleted: "staged: deleted", folder: "staged: new folder" } as const;

export function FileTree({ pg }: { pg: Playground }) {
  const { state, dispatch } = pg;
  const session = state.session;
  const staged: StagedGroup[] = state.review ?? state.run.staged;
  const stagedByPath = useMemo(() => new Map(staged.map((g) => [g.path, g])), [staged]);
  const touched = useMemo(() => new Set(session?.touched ?? []), [session?.touched]);

  // Staged new files aren't in the repo yet; show them in the tree as ghosts.
  const paths = useMemo(() => {
    const real = session?.files.map((f) => f.path) ?? [];
    const ghosts = staged.filter((g) => g.change === "created").map((g) => g.path);
    return [...new Set([...real, ...ghosts])];
  }, [session?.files, staged]);
  const tree = useMemo(() => buildTree(paths), [paths]);
  const ghostSet = useMemo(() => new Set(staged.filter((g) => g.change === "created").map((g) => g.path)), [staged]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (state.sessionStatus === "loading" && !session) {
    return (
      <div className="tree-skeleton" aria-busy="true" aria-label="Loading files">
        {Array.from({ length: 9 }, (_, i) => <span key={i} style={{ width: `${40 + ((i * 37) % 50)}%` }} />)}
      </div>
    );
  }
  if (!session) return <p className="pane-empty">No repo loaded.</p>;

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (node: Node, depth: number): React.ReactNode =>
    [...node.children.values()].sort(sortNodes).map((child) => {
      if (!child.isFile) {
        const open = !collapsed.has(child.path);
        return (
          <li key={child.path}>
            <button
              type="button"
              className="tree-row tree-dir"
              aria-expanded={open}
              style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
              onClick={() => toggle(child.path)}
            >
              <ChevronRight aria-hidden size={13} className="tree-chevron" />
              <Folder aria-hidden size={14} />
              <span className="tree-name">{child.name}</span>
            </button>
            {open && <ul>{render(child, depth + 1)}</ul>}
          </li>
        );
      }
      const g = stagedByPath.get(child.path);
      const isGhost = ghostSet.has(child.path);
      const selected = state.selectedPath === child.path;
      return (
        <li key={child.path}>
          <button
            type="button"
            className="tree-row tree-file"
            aria-current={selected || undefined}
            data-staged={g ? g.change : undefined}
            data-touched={touched.has(child.path) || undefined}
            data-ghost={isGhost || undefined}
            style={{ paddingLeft: `${1.35 + depth * 0.85}rem` }}
            onClick={() => (isGhost ? dispatch({ type: "set", patch: { centerView: "review", pane: "code" } }) : dispatch({ type: "select", path: child.path }))}
          >
            <File aria-hidden size={14} />
            <span className="tree-name">{child.name}</span>
            {g && (
              <span className="tree-mark tree-mark-staged" title={CHANGE_WORD[g.change]}>
                {CHANGE_LETTER[g.change]}
                <span className="sr-only">{CHANGE_WORD[g.change]}</span>
              </span>
            )}
            {!g && touched.has(child.path) && (
              <span className="tree-mark tree-mark-applied" title="Changed and applied in this session">
                <span className="sr-only">applied in this session</span>
              </span>
            )}
          </button>
        </li>
      );
    });

  const total = session.files.reduce((n, f) => n + f.size, 0);

  return (
    <div className="tree">
      <div className="pane-head">
        <span className="pane-title">{session.label}</span>
        <span className="pane-meta">
          {session.files.length} files · {(total / 1024).toFixed(1)} KB
        </span>
      </div>
      <ul className="tree-list" aria-label={`Files in ${session.label}`}>
        {render(tree, 0)}
      </ul>
      {staged.length > 0 && (
        <p className="tree-legend">
          <span className="legend-staged" /> staged in the overlay
          {touched.size > 0 && (
            <>
              <span className="legend-applied" /> applied
            </>
          )}
        </p>
      )}
    </div>
  );
}
