import type { ActionTracker } from "../../modes/agent/action-tracker.ts";
import type { ToolExecutor } from "../../modes/agent/tool-executor.ts";
import type { Plan } from "../../modes/plan/types.ts";
import type { MemoryFS } from "./memory-fs.ts";
import type { ReviewGroupDTO } from "./review.ts";

export type RepoSource =
  | { kind: "sample"; id: string }
  | { kind: "github"; owner: string; repo: string; ref: string };

export interface PendingReview {
  tracker: ActionTracker;
  executor: ToolExecutor;
  groups: ReviewGroupDTO[];
}

export interface Session {
  id: string;
  ip: string;
  createdAt: number;
  lastSeen: number;
  label: string;
  source: RepoSource;
  /** The virtual repo the agent works against. */
  repo: MemoryFS;
  /** Pristine copy, for "reset repo". */
  original: MemoryFS;
  /** Paths changed by approved reviews in this session. */
  touched: Set<string>;
  running?: AbortController;
  pending?: PendingReview;
  plan?: Plan;
}

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLimitError";
  }
}

type Clock = () => number;

/** In-memory sessions with idle TTL, a global cap and a per-IP cap. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly opts: { ttlMs: number; maxSessions: number; maxPerIp: number },
    private readonly now: Clock = Date.now,
  ) {}

  create(ip: string, label: string, source: RepoSource, repo: MemoryFS): Session {
    this.sweep();

    const mine = [...this.sessions.values()].filter((s) => s.ip === ip);
    if (mine.length >= this.opts.maxPerIp) {
      // Recycle this visitor's least recently used idle session.
      const idle = mine.filter((s) => !s.running).sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!idle) throw new SessionLimitError("Too many open playgrounds from your network.");
      this.delete(idle.id);
    }

    if (this.sessions.size >= this.opts.maxSessions) {
      const idle = [...this.sessions.values()]
        .filter((s) => !s.running)
        .sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!idle) throw new SessionLimitError("The playground is at capacity. Try again shortly.");
      this.delete(idle.id);
    }

    const t = this.now();
    const session: Session = {
      id: crypto.randomUUID(),
      ip,
      createdAt: t,
      lastSeen: t,
      label,
      source,
      repo,
      original: repo.clone(),
      touched: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Look up and refresh a session; expired sessions are gone. */
  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.expired(s)) {
      this.delete(id);
      return undefined;
    }
    s.lastSeen = this.now();
    return s;
  }

  expiresAt(s: Session): number {
    return s.lastSeen + this.opts.ttlMs;
  }

  delete(id: string): void {
    const s = this.sessions.get(id);
    s?.running?.abort();
    this.sessions.delete(id);
  }

  sweep(): number {
    let removed = 0;
    for (const s of [...this.sessions.values()]) {
      if (this.expired(s)) {
        this.delete(s.id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }

  private expired(s: Session): boolean {
    return !s.running && this.now() - s.lastSeen > this.opts.ttlMs;
  }
}
