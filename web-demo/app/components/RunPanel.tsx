import { ArrowRight, ChevronRight, CircleAlert, CircleCheck, CircleX, KeyRound, LoaderCircle, Play, Square, TriangleAlert, Info } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import type { Mode, Plan } from "../lib/types.ts";
import type { TranscriptItem } from "../state/playground.ts";
import type { Playground } from "../state/usePlayground.ts";
import { Fang } from "./Brand.tsx";

const MODE_LABEL: Record<Mode | "plan-exec", string> = { ask: "Ask", plan: "Plan", agent: "Agent", "plan-exec": "Plan · execute" };
const MODE_HINT: Record<Mode, string> = {
  ask: "Read-only questions about this repo.",
  plan: "Research, then a step plan you can tick and run.",
  agent: "Stages edits in the overlay for your review.",
};

function Markdown({ text }: { text: string }) {
  // renderMarkdown escapes raw HTML and only allows http(s)/mailto links.
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function useCountdown(until?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : null;
}

function Notice({ item, onKey }: { item: Extract<TranscriptItem, { kind: "notice" }>; onKey: () => void }) {
  const left = useCountdown(item.retryAt);
  const Icon = item.tone === "info" ? Info : item.tone === "warn" ? TriangleAlert : CircleAlert;
  const offerKey = ["rate_limited", "daily_budget", "no_server_key", "model_rate_limited", "model_not_allowed"].includes(item.code);
  return (
    <div className={`notice notice-${item.tone}`} role={item.tone === "info" ? "status" : "alert"}>
      <Icon aria-hidden size={16} className="notice-icon" />
      <div>
        <p>{item.message}</p>
        {(left || offerKey) && (
          <p className="notice-actions">
            {left && <span className="notice-timer">Free runs reopen in {left}</span>}
            {offerKey && (
              <button type="button" className="linkish" onClick={onKey}>
                Use your own OpenRouter key
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function PlanBlock({ plan, pg, live }: { plan: Plan; pg: Playground; live: boolean }) {
  const { state, dispatch, run } = pg;
  const caps = state.config?.limits[state.key ? "byok" : "server"];
  const max = caps?.planExecMaxSelected ?? 4;
  const picked = state.planSelection.length;
  const over = picked > max;
  const interactive = live && state.run.status !== "running" && !state.review;
  return (
    <div className="plan">
      {plan.researchSummary && (
        <div className="plan-summary">
          <Markdown text={plan.researchSummary} />
        </div>
      )}
      <fieldset className="plan-steps" disabled={!interactive}>
        <legend>{plan.steps.length} steps. Tick the ones to run.</legend>
        {plan.steps.map((s, i) => (
          <label key={s.id} className="plan-step">
            <input type="checkbox" checked={state.planSelection.includes(s.id)} onChange={() => dispatch({ type: "togglePlanStep", id: s.id })} />
            <span className="plan-num">{i + 1}</span>
            <span className="plan-text">
              <span className="plan-title">{s.title}</span>
              <span className="plan-desc">{s.description}</span>
            </span>
            {s.complexity && <span className={`cx cx-${s.complexity}`}>{s.complexity}</span>}
          </label>
        ))}
      </fieldset>
      {interactive && (
        <div className="plan-run">
          {over && <p className="plan-cap">This key runs up to {max} steps at once. Untick {picked - max}.</p>}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!picked || over}
            onClick={() =>
              void run("plan-exec", {
                stepIds: state.planSelection,
                label: `Execute ${picked} of ${plan.steps.length} steps: ${plan.goal}`,
              })
            }
          >
            <Play aria-hidden size={14} /> Execute {picked} {picked === 1 ? "step" : "steps"}
          </button>
        </div>
      )}
    </div>
  );
}

function Item({ item, pg, latestPlanId, onKey }: { item: TranscriptItem; pg: Playground; latestPlanId: number; onKey: () => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="t-user">
          <ChevronRight aria-hidden size={15} className="t-prompt" />
          <div>
            <span className="t-mode">{MODE_LABEL[item.mode]}</span>
            <p>{item.text}</p>
          </div>
        </div>
      );
    case "text":
      return <Markdown text={item.text} />;
    case "tool":
      return (
        <div className="t-tool" data-status={item.status}>
          {item.status === "running" ? (
            <LoaderCircle aria-hidden size={13} className="spin" />
          ) : item.status === "ok" ? (
            <CircleCheck aria-hidden size={13} />
          ) : (
            <CircleX aria-hidden size={13} />
          )}
          <span className="t-tool-name">{item.name}</span>
          <span className="t-tool-arg">{item.preview}</span>
          {item.summary && <span className="t-tool-sum">{item.summary}</span>}
        </div>
      );
    case "phase":
      return (
        <div className="t-phase">
          Step {item.index + 1} of {item.total}: {item.title}
        </div>
      );
    case "plan":
      return <PlanBlock plan={item.plan} pg={pg} live={item.id === latestPlanId} />;
    case "notice":
      return <Notice item={item} onKey={onKey} />;
    case "done": {
      const writes = item.mode === "agent" || item.mode === "plan-exec";
      const summary =
        item.mode === "plan"
          ? `Plan drafted${item.steps ? ` after ${item.steps} research ${item.steps === 1 ? "call" : "calls"}` : ""}.`
          : `Finished in ${item.steps} ${item.steps === 1 ? "step" : "steps"}.`;
      return (
        <div className="t-done">
          <span>
            {summary}
            {item.hitStepCap && " Stopped at the step cap; anything staged so far is kept."}
          </span>
          {writes && item.staged === 0 && <span className="t-done-empty">No changes were staged, so there's nothing to review.</span>}
          {writes && item.staged > 0 && pg.state.review && (
            <button type="button" className="linkish" onClick={() => pg.dispatch({ type: "set", patch: { centerView: "review", pane: "code" } })}>
              Review {item.staged} staged {item.staged === 1 ? "file" : "files"} <ArrowRight aria-hidden size={13} />
            </button>
          )}
        </div>
      );
    }
  }
}

function KeyField({ pg, open, setOpen }: { pg: Playground; open: boolean; setOpen: (o: boolean) => void }) {
  const { state, dispatch } = pg;
  const [draft, setDraft] = useState("");
  if (!open) return null;
  const save = () => {
    const key = draft.trim();
    if (!key) return;
    dispatch({ type: "set", patch: { key } });
    setDraft("");
    setOpen(false);
  };
  return (
    <div className="keyfield">
      {state.key ? (
        <p>
          Your key is set for this tab. It's sent with each run and never stored on the server.{" "}
          <button type="button" className="linkish" onClick={() => dispatch({ type: "set", patch: { key: "", model: state.config?.defaultModel ?? "" } })}>
            Remove it
          </button>
        </p>
      ) : (
        <>
          <label htmlFor="or-key">OpenRouter API key</label>
          <div className="keyfield-row">
            <input
              id="or-key"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="sk-or-…"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!draft.trim()}>Use key</button>
          </div>
          <p className="keyfield-note">Kept in this tab's memory only. Sent with each run, never logged or stored. Unlocks faster models and higher limits.</p>
        </>
      )}
    </div>
  );
}

export function RunPanel({ pg }: { pg: Playground }) {
  const { state, dispatch, run, cancel } = pg;
  const [keyOpen, setKeyOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = state.run.status === "running";
  const cfg = state.config;
  const sample = cfg?.samples.find((s) => state.session?.source.kind === "sample" && s.id === state.session.source.id);
  const suggestions = sample?.prompts[state.mode] ?? [];
  const models = (state.key ? cfg?.byokModels : cfg?.serverModels) ?? [];
  const max = cfg?.limits.promptMaxChars ?? 2000;
  const latestPlanId = [...state.transcript].reverse().find((t) => t.kind === "plan")?.id ?? -1;
  const canRun = !!state.session && !running && state.prompt.trim().length > 0 && state.prompt.length <= max;

  // Keep the newest output in view unless the visitor scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.transcript]);

  // Model list depends on whose key pays.
  const modelList = models.join("|");
  useEffect(() => {
    if (cfg && !modelList.split("|").includes(state.model)) dispatch({ type: "set", patch: { model: cfg.defaultModel } });
  }, [cfg, modelList, state.model, dispatch]);

  const submit = () => canRun && void run(state.mode);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="run">
      <div className="pane-head run-head">
        {running ? (
          <>
            <span className="pane-title run-live">
              <span className="live-dot" aria-hidden /> {MODE_LABEL[state.run.mode ?? state.mode]}
            </span>
            <span className="pane-meta">
              {state.run.phase && `step ${state.run.phase.index + 1}/${state.run.phase.total} · `}
              tool step {state.run.step}/{state.run.maxSteps || "…"}
            </span>
            <button type="button" className="btn btn-ghost btn-xs" onClick={cancel}>
              <Square aria-hidden size={12} /> Stop
            </button>
          </>
        ) : (
          <>
            <span className="pane-title">Run</span>
            <span className="pane-meta">{state.key ? "your key" : "shared free key"}</span>
          </>
        )}
      </div>

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        aria-live="polite"
        aria-busy={running}
      >
        {state.transcript.length === 0 && (
          <div className="t-empty">
            <Fang className="fang t-empty-fang" />
            <p>
              Pick a mode, then ask or instruct. Edits never touch the repo until you approve them in the review.
            </p>
          </div>
        )}
        {state.transcript.map((item) => (
          <Item key={item.id} item={item} pg={pg} latestPlanId={latestPlanId} onKey={() => setKeyOpen(true)} />
        ))}
        {running && state.transcript.at(-1)?.kind === "user" && (
          <div className="t-waiting">
            <LoaderCircle aria-hidden size={13} className="spin" /> Waiting for the model…
          </div>
        )}
      </div>

      {running && state.run.staged.length > 0 && (
        <div className="overlay-strip" aria-label="Staged in the overlay">
          <span className="overlay-strip-title">overlay · {state.run.staged.length} staged</span>
          <ul>
            {state.run.staged.map((g) => (
              <li key={g.path}>
                <span className="os-path">{g.path}</span>
                <span className="stat-add">+{g.added}</span>
                <span className="stat-del">−{g.removed}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="composer">
        <div className="mode-switch" role="radiogroup" aria-label="Mode">
          {(["ask", "plan", "agent"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={state.mode === m}
              disabled={running}
              onClick={() => dispatch({ type: "set", patch: { mode: m } })}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <p className="mode-hint">{MODE_HINT[state.mode]}</p>

        {!state.prompt && suggestions.length > 0 && !running && (
          <div className="suggestions" aria-label="Suggested prompts">
            {suggestions.map((s) => (
              <button key={s} type="button" className="suggestion" onClick={() => dispatch({ type: "set", patch: { prompt: s } })}>
                {s}
              </button>
            ))}
          </div>
        )}

        <label htmlFor="prompt" className="sr-only">Prompt</label>
        <textarea
          id="prompt"
          value={state.prompt}
          onChange={(e) => dispatch({ type: "set", patch: { prompt: e.target.value } })}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={state.mode === "ask" ? "How does…" : state.mode === "plan" ? "Goal to plan…" : "Task for the agent…"}
          disabled={!state.session}
          maxLength={max + 200}
        />
        {state.prompt.length > max * 0.8 && (
          <p className={state.prompt.length > max ? "char-count over" : "char-count"}>
            {state.prompt.length}/{max}
          </p>
        )}

        <div className="composer-row">
          <label htmlFor="model" className="sr-only">Model</label>
          <select id="model" value={state.model} onChange={(e) => dispatch({ type: "set", patch: { model: e.target.value } })} disabled={running}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm key-btn"
            aria-expanded={keyOpen}
            data-active={!!state.key || undefined}
            onClick={() => setKeyOpen((o) => !o)}
          >
            <KeyRound aria-hidden size={14} /> {state.key ? "Your key" : "Own key"}
          </button>
          {running ? (
            <button type="button" className="btn btn-ghost btn-run" onClick={cancel}>
              <Square aria-hidden size={14} /> Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-run" disabled={!canRun} onClick={submit}>
              <Play aria-hidden size={14} /> Run
            </button>
          )}
        </div>
        <KeyField pg={pg} open={keyOpen} setOpen={setKeyOpen} />
      </div>
    </div>
  );
}
