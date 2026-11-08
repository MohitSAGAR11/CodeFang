import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, ApiError, streamRun } from "../lib/api.ts";
import type { Mode } from "../lib/types.ts";
import { initialState, reducer } from "./playground.ts";

const asApiError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError("internal", "Something went wrong. Try again.", 0);

export function usePlayground() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const runAbort = useRef<AbortController | null>(null);
  const lastSource = useRef<{ sample: string } | { github: string } | null>(null);

  // Config once.
  useEffect(() => {
    let alive = true;
    api
      .config()
      .then((config) => alive && dispatch({ type: "config", config }))
      .catch((e) => alive && dispatch({ type: "configError", message: asApiError(e).message }));
    return () => {
      alive = false;
    };
  }, []);

  const openSource = useCallback(async (source: { sample: string } | { github: string }) => {
    runAbort.current?.abort();
    lastSource.current = source;
    dispatch({ type: "sessionLoading" });
    try {
      const session = await api.createSession(source);
      dispatch({ type: "sessionReady", session, fresh: true });
      return true;
    } catch (e) {
      const err = asApiError(e);
      dispatch({ type: "sessionError", code: err.code, message: err.message });
      return false;
    }
  }, []);

  // First sample as soon as config arrives.
  const firstSample = state.config?.samples[0]?.id;
  useEffect(() => {
    if (firstSample && !lastSource.current) void openSource({ sample: firstSample });
  }, [firstSample, openSource]);

  // Load the selected file when it isn't cached.
  const sessionId = state.session?.id;
  const selected = state.selectedPath;
  const cached = selected ? state.files[selected] : undefined;
  useEffect(() => {
    if (!sessionId || !selected || cached) return;
    let alive = true;
    api
      .file(sessionId, selected)
      .then((f) => alive && dispatch({ type: "fileLoaded", path: selected, content: f.content }))
      .catch((e) => {
        if (!alive) return;
        const err = asApiError(e);
        if (err.code === "session_expired") dispatch({ type: "sessionError", code: err.code, message: err.message });
        else dispatch({ type: "fileError", path: selected });
      });
    return () => {
      alive = false;
    };
  }, [sessionId, selected, cached]);

  const handleSessionLoss = (err: ApiError) => {
    if (err.code === "session_expired") dispatch({ type: "sessionError", code: err.code, message: err.message });
  };

  const run = useCallback(
    async (mode: Mode | "plan-exec", opts: { prompt?: string; stepIds?: string[]; label?: string } = {}) => {
      if (!state.session || state.run.status === "running") return;
      const prompt = (opts.prompt ?? state.prompt).trim();
      const controller = new AbortController();
      runAbort.current = controller;
      dispatch({ type: "runStart", mode, text: opts.label ?? prompt });
      try {
        const events = streamRun(
          state.session.id,
          { mode, prompt, model: state.model || undefined, stepIds: opts.stepIds },
          state.key || undefined,
          controller.signal,
        );
        for await (const ev of events) dispatch({ type: "runEvent", ev });
      } catch (e) {
        const err = asApiError(e);
        dispatch({ type: "runFailed", error: err });
        handleSessionLoss(err);
      } finally {
        if (runAbort.current === controller) runAbort.current = null;
        dispatch({ type: "runEnd" });
      }
    },
    [state.session, state.run.status, state.prompt, state.model, state.key],
  );

  const cancel = useCallback(() => {
    const id = state.session?.id;
    runAbort.current?.abort();
    if (id) api.cancel(id).catch(() => {});
  }, [state.session?.id]);

  const applyReview = useCallback(async () => {
    if (!state.session || !state.review) return;
    dispatch({ type: "applying" });
    try {
      const result = await api.review(state.session.id, state.decisions);
      dispatch({ type: "applied", result });
    } catch (e) {
      const err = asApiError(e);
      dispatch({ type: "applyFailed", error: err });
      handleSessionLoss(err);
    }
  }, [state.session, state.review, state.decisions]);

  const discardReview = useCallback(async () => {
    if (!state.session) return;
    try {
      const session = await api.discardReview(state.session.id);
      dispatch({ type: "reviewDiscarded", session });
    } catch (e) {
      handleSessionLoss(asApiError(e));
    }
  }, [state.session]);

  const resetRepo = useCallback(async () => {
    if (!state.session) return;
    try {
      const session = await api.reset(state.session.id);
      dispatch({ type: "sessionReady", session, fresh: true });
    } catch (e) {
      handleSessionLoss(asApiError(e));
    }
  }, [state.session]);

  const restart = useCallback(() => {
    if (lastSource.current) void openSource(lastSource.current);
  }, [openSource]);

  return { state, dispatch, openSource, run, cancel, applyReview, discardReview, resetRepo, restart };
}

export type Playground = ReturnType<typeof usePlayground>;
