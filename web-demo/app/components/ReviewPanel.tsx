import { ArrowLeft, Check, ChevronDown, Download, FilePlus2, FileMinus2, FileDiff, FolderPlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { parsePatch } from "../lib/diff.ts";
import type { Decision, ReviewGroupDTO } from "../lib/types.ts";
import type { Playground } from "../state/usePlayground.ts";

const CHANGE = {
  created: { label: "new file", Icon: FilePlus2 },
  modified: { label: "modified", Icon: FileDiff },
  deleted: { label: "deleted", Icon: FileMinus2 },
  folder: { label: "new folder", Icon: FolderPlus },
} as const;

function DiffTable({ patch }: { patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="diff-scroll" tabIndex={0}>
      <table className="diff-table">
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === "hunk") {
              return (
                <tr key={i} className="d-hunk">
                  <td colSpan={3}>{r.text}</td>
                </tr>
              );
            }
            if (r.kind === "note") {
              return (
                <tr key={i} className="d-note">
                  <td colSpan={3}>{r.text}</td>
                </tr>
              );
            }
            const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
            return (
              <tr key={i} className={`d-${r.kind}`}>
                <td className="ln" aria-hidden>{r.oldNo ?? ""}</td>
                <td className="ln" aria-hidden>{r.newNo ?? ""}</td>
                <td className="lc">
                  <span className="d-sign" aria-hidden>{sign}</span>
                  <span className="sr-only">{r.kind === "add" ? "added: " : r.kind === "del" ? "removed: " : ""}</span>
                  {r.text || " "}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type FileReviewProps = {
  group: ReviewGroupDTO;
  decision: Decision | undefined;
  onDecide: (d: Decision) => void;
  disabled: boolean;
};

function FileReview({ group, decision, onDecide, disabled }: FileReviewProps) {
  const [open, setOpen] = useState(true);
  const { label, Icon } = CHANGE[group.change];
  const bodyId = `diff-${group.id}`;
  return (
    <article className="file-review" data-decision={decision ?? "pending"} data-change={group.change}>
      <header className="fr-head">
        <button type="button" className="fr-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          <ChevronDown aria-hidden size={15} className="fr-chevron" />
          <Icon aria-hidden size={15} />
          <span className="fr-path">{group.path}</span>
        </button>
        <span className="fr-kind">{label}</span>
        {group.patch !== null && (
          <span className="fr-stat">
            <span className="stat-add">+{group.added}</span> <span className="stat-del">−{group.removed}</span>
          </span>
        )}
        <div className="decide" role="radiogroup" aria-label={`Decision for ${group.path}`}>
          <button type="button" role="radio" aria-checked={decision === "approve"} className="decide-approve" disabled={disabled} onClick={() => onDecide("approve")}>
            <Check aria-hidden size={14} strokeWidth={2.5} /> Approve
          </button>
          <button type="button" role="radio" aria-checked={decision === "reject"} className="decide-reject" disabled={disabled} onClick={() => onDecide("reject")}>
            <X aria-hidden size={14} strokeWidth={2.5} /> Reject
          </button>
        </div>
      </header>
      {open && (
        <div id={bodyId}>
          {group.patch ? <DiffTable patch={group.patch} /> : <p className="fr-folder">Creates the folder <code>{group.path}/</code>.</p>}
        </div>
      )}
    </article>
  );
}

function downloadPatch(patch: string, label: string) {
  const blob = new Blob([patch], { type: "text/x-diff" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `codefang-${label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.patch`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AppliedResult({ pg }: { pg: Playground }) {
  const { state, dispatch } = pg;
  const r = state.applied!;
  const label = state.session?.label ?? "changes";
  return (
    <div className="applied">
      <div className="pane-head">
        <span className="pane-title">Review complete</span>
      </div>
      <div className="applied-body">
        <h3>
          {r.applied.length
            ? `${r.applied.length} ${r.applied.length === 1 ? "file" : "files"} written to the virtual repo.`
            : "Nothing was written."}
        </h3>
        {r.rejected.length > 0 && <p className="applied-sub">{r.rejected.length} discarded from the overlay; those files are untouched.</p>}
        <ul className="applied-list">
          {r.applied.map((p) => (
            <li key={p} className="applied-yes">
              <Check aria-hidden size={14} strokeWidth={2.5} />
              <button type="button" className="linkish" onClick={() => dispatch({ type: "select", path: p })}>{p}</button>
            </li>
          ))}
          {r.rejected.map((p) => (
            <li key={p} className="applied-no">
              <X aria-hidden size={14} strokeWidth={2.5} /> <span>{p}</span>
            </li>
          ))}
        </ul>
        {r.errors.length > 0 && (
          <div className="notice notice-error" role="alert">
            {r.errors.length} operation(s) failed: {r.errors.join("; ")}
          </div>
        )}
        <div className="applied-actions">
          {r.patch && (
            <button type="button" className="btn btn-primary" onClick={() => downloadPatch(r.patch, label)}>
              <Download aria-hidden size={16} /> Download .patch
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => dispatch({ type: "dismissApplied" })}>
            <ArrowLeft aria-hidden size={16} /> Back to code
          </button>
        </div>
        {r.patch && <p className="applied-hint">Works with <code>git apply</code> in a checkout of the same repo.</p>}
      </div>
    </div>
  );
}

export function ReviewPanel({ pg }: { pg: Playground }) {
  const { state, dispatch, applyReview, discardReview } = pg;
  if (!state.review) return state.applied ? <AppliedResult pg={pg} /> : null;

  const groups = state.review;
  const decided = groups.filter((g) => state.decisions[g.id]).length;
  const approved = groups.filter((g) => state.decisions[g.id] === "approve").length;
  const rejected = decided - approved;
  const remaining = groups.length - decided;
  const totals = groups.reduce((t, g) => ({ add: t.add + g.added, del: t.del + g.removed }), { add: 0, del: 0 });
  const busy = state.applying || state.run.status === "running";

  const applyLabel = remaining
    ? `${remaining} ${remaining === 1 ? "file" : "files"} still undecided`
    : approved
      ? `Apply ${approved}${rejected ? `, discard ${rejected}` : ""}`
      : "Discard all";

  return (
    <div className="review">
      <div className="pane-head review-head">
        <span className="pane-title">Review</span>
        <span className="pane-meta">
          {groups.length} staged in the overlay · <span className="stat-add">+{totals.add}</span> <span className="stat-del">−{totals.del}</span>
        </span>
        <div className="review-bulk">
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => dispatch({ type: "decideAll", decision: "approve" })}>
            Approve all
          </button>
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => dispatch({ type: "decideAll", decision: "reject" })}>
            Reject all
          </button>
        </div>
      </div>

      <div className="review-list">
        {groups.map((g) => (
          <FileReview
            key={g.id}
            group={g}
            decision={state.decisions[g.id]}
            disabled={busy}
            onDecide={(decision) => dispatch({ type: "decide", id: g.id, decision })}
          />
        ))}
      </div>

      <div className="review-foot">
        <p className="review-foot-note">Nothing has been written yet. Approved files are applied to this playground's virtual repo.</p>
        <div className="review-foot-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void discardReview()}>
            Discard everything
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || remaining > 0} onClick={() => void applyReview()}>
            {state.applying ? "Applying…" : applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
