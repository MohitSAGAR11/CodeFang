import type { ReviewGroupDTO, ReviewResult } from "../../server/review.ts";
import type { Plan, PlanStep } from "../../../modes/plan/types.ts";
import type { RepoSource } from "../../server/sessions.ts";

export type { ReviewGroupDTO, Plan, PlanStep, RepoSource };

export type Mode = "ask" | "plan" | "agent";
export type RunMode = Mode | "plan-exec";
export type Decision = "approve" | "reject";

export interface SampleInfo {
  id: string;
  name: string;
  tagline: string;
  language: string;
  fileCount: number;
  prompts: Record<Mode, string[]>;
}

export interface Caps {
  ask: number;
  plan: number;
  agent: number;
  planExecMaxSelected: number;
}

export interface ConfigDTO {
  defaultModel: string;
  serverModels: string[];
  byokModels: string[];
  serverKeyAvailable: boolean;
  githubImport: boolean;
  webTools: boolean;
  samples: SampleInfo[];
  limits: {
    promptMaxChars: number;
    server: Caps;
    byok: Caps;
    runsPerWindow: number;
    rateWindowMinutes: number;
    repoMaxFiles: number;
    repoMaxMB: number;
    sessionTtlMinutes: number;
  };
}

export interface SessionDTO {
  id: string;
  label: string;
  source: RepoSource;
  files: Array<{ path: string; size: number }>;
  touched: string[];
  expiresAt: number;
  pending: ReviewGroupDTO[] | null;
  plan: Plan | null;
}

export type ReviewResultDTO = ReviewResult & { session: SessionDTO };

export interface StagedGroup {
  id: string;
  path: string;
  change: ReviewGroupDTO["change"];
  added: number;
  removed: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}
