import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { highlightLines } from "../lib/highlight.tsx";
import type { Playground } from "../state/usePlayground.ts";

export function CodeView({ pg }: { pg: Playground }) {
  const { state, dispatch } = pg;
  const path = state.selectedPath;
  const entry = path ? state.files[path] : undefined;
  const staged = (state.review ?? state.run.staged).find((g) => g.path === path);
  const applied = path ? state.session?.touched.includes(path) : false;
  const lines = useMemo(
    () => (entry?.content !== undefined && path ? highlightLines(entry.content, path) : null),
    [entry?.content, path],
  );

  if (!path) return <p className="pane-empty">Pick a file to read it.</p>;

  return (
    <div className="code">
      <div className="pane-head">
        <span className="pane-title code-path">{path}</span>
        {applied && <span className="pill pill-applied">applied</span>}
        {(state.review || state.applied) && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => dispatch({ type: "set", patch: { centerView: "review" } })}>
            {state.review ? `Review ${state.review.length}` : "Last review"} <ArrowRight aria-hidden size={13} />
          </button>
        )}
      </div>

      {staged && (
        <div className="code-banner" role="note">
          <span>This file has a staged change. What you see is still the repo version.</span>
          {state.review && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => dispatch({ type: "set", patch: { centerView: "review" } })}>
              See the diff
            </button>
          )}
        </div>
      )}

      {(!entry || entry.status === "loading") && (
        <div className="code-skeleton" aria-busy="true" aria-label="Loading file">
          {Array.from({ length: 14 }, (_, i) => <span key={i} style={{ width: `${20 + ((i * 53) % 70)}%` }} />)}
        </div>
      )}
      {entry?.status === "error" && <p className="pane-empty">Couldn't load this file. It may have been deleted.</p>}
      {lines && (
        <div className="code-scroll" tabIndex={0} aria-label={`Contents of ${path}`}>
          <table className="code-table">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="ln" aria-hidden>{i + 1}</td>
                  <td className="lc">{line.length ? line : " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
