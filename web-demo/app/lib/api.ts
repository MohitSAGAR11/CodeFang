import type { ApiErrorBody, ConfigDTO, Decision, ReviewResultDTO, RunMode, SessionDTO } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const NETWORK: ApiErrorBody = { code: "network", message: "Can't reach the playground server. Check your connection and try again." };

async function toApiError(res: Response): Promise<ApiError> {
  const retry = Number(res.headers.get("retry-after") ?? "") || undefined;
  try {
    const body = (await res.json()) as { error?: ApiErrorBody };
    if (body.error) return new ApiError(body.error.code, body.error.message, res.status, retry);
  } catch {
    /* not JSON */
  }
  return new ApiError("http_" + res.status, `The server returned ${res.status}.`, res.status, retry);
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(NETWORK.code, NETWORK.message, 0);
  }
  if (!res.ok) throw await toApiError(res);
  return ((await res.json()) as { data: T }).data;
}

export const api = {
  config: () => request<ConfigDTO>("GET", "/api/config"),
  createSession: (source: { sample: string } | { github: string }) => request<SessionDTO>("POST", "/api/sessions", source),
  session: (id: string) => request<SessionDTO>("GET", `/api/sessions/${id}`),
  file: (id: string, path: string) =>
    request<{ path: string; content: string }>("GET", `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`),
  review: (id: string, decisions: Record<string, Decision>) =>
    request<ReviewResultDTO>("POST", `/api/sessions/${id}/review`, { decisions }),
  discardReview: (id: string) => request<SessionDTO>("DELETE", `/api/sessions/${id}/review`),
  reset: (id: string) => request<SessionDTO>("POST", `/api/sessions/${id}/reset`, {}),
  cancel: (id: string) => request<{ cancelled: boolean }>("POST", `/api/sessions/${id}/cancel`, {}),
};

export interface RunBody {
  mode: RunMode;
  prompt: string;
  model?: string;
  stepIds?: string[];
}

export type RunEvent = { event: string; data: any };

/**
 * POST a run and yield its server-sent events. EventSource can't POST or send
 * headers, so this reads the stream by hand. The visitor's key travels only in
 * this request's header.
 */
export async function* streamRun(
  sessionId: string,
  body: RunBody,
  key: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<RunEvent> {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) return;
    throw new ApiError(NETWORK.code, NETWORK.message, 0);
  }
  if (!res.ok || !res.body) throw await toApiError(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue; // keep-alive comment
        yield { event, data: JSON.parse(data) };
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    throw new ApiError("stream_lost", "The connection dropped mid-run. Your repo is unchanged; try again.", 0);
  } finally {
    reader.releaseLock();
  }
}
