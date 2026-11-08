import { FileCode2, FolderTree, GitBranch, RotateCcw, SquareTerminal } from "lucide-react";
import { useState, type FormEvent } from "react";
import { usePlayground, type Playground as PG } from "../state/usePlayground.ts";
import type { Pane } from "../state/playground.ts";
import { CodeView } from "./CodeView.tsx";
import { FileTree } from "./FileTree.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { RunPanel } from "./RunPanel.tsx";

function RepoBar({ pg }: { pg: PG }) {
  const { state, openSource, resetRepo } = pg;
  const [repo, setRepo] = useState("");
  const [lastTried, setLastTried] = useState<"sample" | "github" | null>(null);
  const busy = state.sessionStatus === "loading" || state.run.status === "running";
  const current = state.session?.source;
  const importError = lastTried === "github" && state.sessionError && state.sessionError.code !== "session_expired" ? state.sessionError : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!repo.trim()) return;
    setLastTried("github");
    if (await openSource({ github: repo.trim() })) setRepo("");
  };

  return (
    <div className="repo-bar">
      <div className="repo-samples" role="group" aria-label="Sample repositories">
        {state.config?.samples.map((s) => {
          const active = current?.kind === "sample" && current.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className="sample-btn"
              aria-pressed={active}
              disabled={busy}
              title={s.tagline}
              onClick={() => {
                setLastTried("sample");
                void openSource({ sample: s.id });
              }}
            >
              <span className="sample-name">{s.name}</span>
              <span className="sample-lang">{s.language}</span>
            </button>
          );
        })}
      </div>

      {state.config?.githubImport && (
        <form className="repo-import" onSubmit={submit}>
          <label htmlFor="gh-repo" className="sr-only">Public GitHub repository</label>
          <GitBranch aria-hidden size={15} className="repo-import-icon" />
          <input
            id="gh-repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repo from GitHub"
            spellCheck={false}
            autoComplete="off"
            maxLength={300}
            aria-invalid={!!importError}
            aria-describedby={importError ? "gh-error" : "gh-hint"}
          />
          <button type="submit" className="btn btn-ghost btn-sm" disabled={busy || !repo.trim()}>
            {state.sessionStatus === "loading" && lastTried === "github" ? "Importing…" : "Import"}
          </button>
          <span id="gh-hint" className="sr-only">
            Public repos only, up to {state.config.limits.repoMaxFiles} source files and {state.config.limits.repoMaxMB} MB.
          </span>
        </form>
      )}

      <button type="button" className="btn btn-ghost btn-sm repo-reset" onClick={() => void resetRepo()} disabled={busy || !state.session}>
        <RotateCcw aria-hidden size={14} /> <span className="repo-reset-label">Reset repo</span>
      </button>

      {importError && (
        <p id="gh-error" className="repo-error" role="alert">
          {importError.message}
        </p>
      )}
    </div>
  );
}

const TABS: Array<{ id: Pane; label: string; Icon: typeof FolderTree }> = [
  { id: "files", label: "Files", Icon: FolderTree },
  { id: "code", label: "Code", Icon: FileCode2 },
  { id: "run", label: "Run", Icon: SquareTerminal },
];

export function Playground() {
  const pg = usePlayground();
  const { state, dispatch, restart } = pg;
  const expired = state.sessionError?.code === "session_expired";
  const reviewCount = state.review?.length ?? 0;

  if (state.configError) {
    return (
      <div className="pg-shell pg-fallback" role="alert">
        <p>The playground server didn't answer: {state.configError}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }

  const showCenterReview = !!(state.review || state.applied) && state.centerView === "review";

  return (
    <div className="pg-shell" data-pane={state.pane}>
      <RepoBar pg={pg} />

      <div className="pg-grid">
        <aside className="pg-pane pg-files" aria-label="Repository files">
          <FileTree pg={pg} />
        </aside>
        <section className="pg-pane pg-center" aria-label={showCenterReview ? "Review" : "Code"}>
          {showCenterReview ? <ReviewPanel pg={pg} /> : <CodeView pg={pg} />}
        </section>
        <section className="pg-pane pg-run" aria-label="Run">
          <RunPanel pg={pg} />
        </section>
      </div>

      <nav className="pg-tabs" aria-label="Playground panes">
        {TABS.map(({ id, label, Icon }) => {
          const text = id === "code" && reviewCount ? "Review" : label;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={state.pane === id}
              onClick={() => dispatch({ type: "set", patch: { pane: id, ...(id === "code" && reviewCount ? { centerView: "review" } : {}) } })}
            >
              <Icon aria-hidden size={17} />
              <span>{text}</span>
              {id === "code" && reviewCount > 0 && <span className="tab-badge">{reviewCount}</span>}
            </button>
          );
        })}
      </nav>

      {expired && (
        <div className="pg-takeover" role="alertdialog" aria-labelledby="expired-title">
          <div>
            <h3 id="expired-title">This playground expired</h3>
            <p>Idle playgrounds are cleared after {state.config?.limits.sessionTtlMinutes ?? 30} minutes, along with their virtual repo.</p>
            <button type="button" className="btn btn-primary" onClick={restart}>Start a fresh one</button>
          </div>
        </div>
      )}
    </div>
  );
}
