import type { ApiError, RunEvent } from "../lib/api.ts";
import type {
  ConfigDTO,
  Decision,
  Mode,
  Plan,
  ReviewGroupDTO,
  ReviewResultDTO,
  SessionDTO,
  StagedGroup,
} from "../lib/types.ts";

export type TranscriptItem =
  | { id: number; kind: "user"; mode: Mode | "plan-exec"; text: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "tool"; callId: string; name: string; preview: string; status: "running" | "ok" | "error"; summary?: string }
  | { id: number; kind: "phase"; title: string; index: number; total: number }
  | { id: number; kind: "plan"; plan: Plan }
  | { id: number; kind: "notice"; tone: "error" | "warn" | "info"; code: string; message: string; retryAt?: number }
  | { id: number; kind: "done"; steps: number; hitStepCap: boolean; mode: Mode | "plan-exec"; staged: number };

export type Pane = "files" | "code" | "run";
export type CenterView = "code" | "review";

export interface RunState {
  status: "idle" | "running";
  mode?: Mode | "plan-exec";
  model?: string;
  keySource?: "server" | "byok";
  step: number;
  maxSteps: number;
  staged: StagedGroup[];
  phase?: { index: number; total: number; title: string };
}

export interface State {
  config: ConfigDTO | null;
  configError: string | null;
  session: SessionDTO | null;
  sessionStatus: "idle" | "loading" | "ready" | "error";
  sessionError: { code: string; message: string } | null;
  selectedPath: string | null;
  files: Record<string, { status: "loading" | "ready" | "error"; content?: string }>;
  transcript: TranscriptItem[];
  run: RunState;
  review: ReviewGroupDTO[] | null;
  decisions: Record<string, Decision>;
  applying: boolean;
  applied: ReviewResultDTO | null;
  plan: Plan | null;
  planSelection: string[];
  mode: Mode;
  model: string;
  key: string;
  prompt: string;
  pane: Pane;
  centerView: CenterView;
}

export const initialState: State = {
  config: null,
  configError: null,
  session: null,
  sessionStatus: "idle",
  sessionError: null,
  selectedPath: null,
  files: {},
  transcript: [],
  run: { status: "idle", step: 0, maxSteps: 0, staged: [] },
  review: null,
  decisions: {},
  applying: false,
  applied: null,
  plan: null,
  planSelection: [],
  mode: "agent",
  model: "",
  key: "",
  prompt: "",
  pane: "run",
  centerView: "code",
};

export type Action =
  | { type: "config"; config: ConfigDTO }
  | { type: "configError"; message: string }
  | { type: "sessionLoading" }
  | { type: "sessionReady"; session: SessionDTO; fresh: boolean }
  | { type: "sessionError"; code: string; message: string }
  | { type: "select"; path: string }
  | { type: "fileLoaded"; path: string; content: string }
  | { type: "fileError"; path: string }
  | { type: "set"; patch: Partial<Pick<State, "mode" | "model" | "key" | "prompt" | "pane" | "centerView">> }
  | { type: "runStart"; mode: Mode | "plan-exec"; text: string }
  | { type: "runEvent"; ev: RunEvent }
  | { type: "runFailed"; error: ApiError }
  | { type: "runEnd" }
  | { type: "decide"; id: string; decision: Decision }
  | { type: "decideAll"; decision: Decision }
  | { type: "applying" }
  | { type: "applied"; result: ReviewResultDTO }
  | { type: "applyFailed"; error: ApiError }
  | { type: "reviewDiscarded"; session: SessionDTO }
  | { type: "dismissApplied" }
  | { type: "togglePlanStep"; id: string }
  | { type: "notice"; tone: "error" | "warn" | "info"; code: string; message: string };

let nextId = 1;
const id = () => nextId++;

function noticeFor(error: ApiError): TranscriptItem {
  const retryAt = error.retryAfterSec ? Date.now() + error.retryAfterSec * 1000 : undefined;
  const tone = error.code === "rate_limited" || error.code === "daily_budget" ? "warn" : "error";
  return { id: id(), kind: "notice", tone, code: error.code, message: error.message, retryAt };
}

/** Drop the file cache entries for paths that changed on the virtual repo. */
function invalidate(files: State["files"], paths: string[]): State["files"] {
  const next = { ...files };
  for (const p of paths) delete next[p];
  return next;
}

function applyRunEvent(state: State, ev: RunEvent): State {
  const t = state.transcript;
  switch (ev.event) {
    case "start":
      return {
        ...state,
        run: { ...state.run, model: ev.data.model, keySource: ev.data.keySource, maxSteps: ev.data.maxSteps, step: 0 },
      };
    case "text": {
      const last = t[t.length - 1];
      if (last?.kind === "text") {
        return { ...state, transcript: [...t.slice(0, -1), { ...last, text: last.text + ev.data.delta }] };
      }
      return { ...state, transcript: [...t, { id: id(), kind: "text", text: ev.data.delta }] };
    }
    case "tool":
      return {
        ...state,
        transcript: [...t, { id: id(), kind: "tool", callId: ev.data.id, name: ev.data.name, preview: ev.data.preview, status: "running" }],
      };
    case "tool-done":
      return {
        ...state,
        transcript: t.map((item) =>
          item.kind === "tool" && item.callId === ev.data.id
            ? { ...item, status: ev.data.ok ? "ok" : "error", summary: ev.data.summary }
            : item,
        ),
      };
    case "staged":
      return { ...state, run: { ...state.run, staged: ev.data.groups } };
    case "step":
      return { ...state, run: { ...state.run, step: ev.data.steps, maxSteps: ev.data.max } };
    case "phase":
      return {
        ...state,
        run: { ...state.run, step: 0, phase: { index: ev.data.index, total: ev.data.total, title: ev.data.title } },
        transcript: [...t, { id: id(), kind: "phase", title: ev.data.title, index: ev.data.index, total: ev.data.total }],
      };
    case "plan":
      return {
        ...state,
        plan: ev.data.plan,
        planSelection: ev.data.plan.steps.map((s: { id: string }) => s.id),
        transcript: [...t, { id: id(), kind: "plan", plan: ev.data.plan }],
      };
    case "review": {
      const groups: ReviewGroupDTO[] = ev.data.groups;
      return {
        ...state,
        review: groups.length ? groups : null,
        decisions: {},
        centerView: groups.length ? "review" : state.centerView,
        pane: groups.length ? "code" : state.pane,
      };
    }
    case "error":
      return {
        ...state,
        transcript: [...t, { id: id(), kind: "notice", tone: ev.data.code === "cancelled" ? "info" : "error", code: ev.data.code, message: ev.data.message }],
      };
    case "done":
      return {
        ...state,
        transcript: [
          ...t,
          {
            id: id(),
            kind: "done",
            steps: ev.data.steps,
            hitStepCap: ev.data.hitStepCap,
            mode: state.run.mode ?? "agent",
            staged: state.run.staged.length,
          },
        ],
      };
    default:
      return state;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "config":
      return { ...state, config: action.config, model: state.model || action.config.defaultModel };
    case "configError":
      return { ...state, configError: action.message };
    case "sessionLoading":
      return { ...state, sessionStatus: "loading", sessionError: null };
    case "sessionReady": {
      const s = action.session;
      const firstFile = s.files.find((f) => /readme/i.test(f.path))?.path ?? s.files[0]?.path ?? null;
      if (!action.fresh) {
        return { ...state, session: s, sessionStatus: "ready", files: invalidate(state.files, s.touched) };
      }
      return {
        ...state,
        session: s,
        sessionStatus: "ready",
        sessionError: null,
        selectedPath: firstFile,
        files: {},
        transcript: [],
        run: initialState.run,
        review: s.pending,
        decisions: {},
        applied: null,
        plan: s.plan,
        planSelection: s.plan?.steps.map((x) => x.id) ?? [],
        centerView: "code",
      };
    }
    case "sessionError":
      return { ...state, sessionStatus: "error", sessionError: { code: action.code, message: action.message } };
    case "select":
      return { ...state, selectedPath: action.path, centerView: "code", pane: "code" };
    case "fileLoaded":
      return { ...state, files: { ...state.files, [action.path]: { status: "ready", content: action.content } } };
    case "fileError":
      return { ...state, files: { ...state.files, [action.path]: { status: "error" } } };
    case "set":
      return { ...state, ...action.patch };
    case "runStart":
      return {
        ...state,
        prompt: action.mode === "plan-exec" ? state.prompt : "",
        review: null,
        decisions: {},
        applied: null,
        plan: action.mode === "plan" ? null : state.plan,
        run: { status: "running", mode: action.mode, step: 0, maxSteps: 0, staged: [] },
        transcript: [...state.transcript, { id: id(), kind: "user", mode: action.mode, text: action.text }],
        pane: "run",
      };
    case "runEvent":
      return applyRunEvent(state, action.ev);
    case "runFailed":
      return { ...state, transcript: [...state.transcript, noticeFor(action.error)] };
    case "runEnd":
      return { ...state, run: { ...state.run, status: "idle", phase: undefined } };
    case "decide":
      return { ...state, decisions: { ...state.decisions, [action.id]: action.decision } };
    case "decideAll":
      return {
        ...state,
        decisions: Object.fromEntries((state.review ?? []).map((g) => [g.id, action.decision])),
      };
    case "applying":
      return { ...state, applying: true };
    case "applied": {
      const r = action.result;
      return {
        ...state,
        applying: false,
        applied: r,
        review: null,
        decisions: {},
        session: r.session,
        run: { ...state.run, staged: [] },
        files: invalidate(state.files, r.applied),
      };
    }
    case "applyFailed":
      return { ...state, applying: false, transcript: [...state.transcript, noticeFor(action.error)] };
    case "reviewDiscarded":
      return { ...state, review: null, decisions: {}, session: action.session, run: { ...state.run, staged: [] }, centerView: "code" };
    case "dismissApplied":
      return { ...state, applied: null, centerView: "code" };
    case "togglePlanStep": {
      const has = state.planSelection.includes(action.id);
      return {
        ...state,
        planSelection: has ? state.planSelection.filter((x) => x !== action.id) : [...state.planSelection, action.id],
      };
    }
    case "notice":
      return {
        ...state,
        transcript: [...state.transcript, { id: id(), kind: "notice", tone: action.tone, code: action.code, message: action.message }],
      };
  }
}
