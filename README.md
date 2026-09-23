```
 ██████╗ ██████╗ ██████╗ ███████╗███████╗ █████╗ ███╗   ██╗ ██████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗████╗  ██║██╔════╝
██║     ██║   ██║██║  ██║█████╗  █████╗  ███████║██╔██╗ ██║██║  ███╗
██║     ██║   ██║██║  ██║██╔══╝  ██╔══╝  ██╔══██║██║╚██╗██║██║   ██║
╚██████╗╚██████╔╝██████╔╝███████╗██║     ██║  ██║██║ ╚████║╚██████╔╝
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝
```

<p align="center">
  <b>▼ Agentic coding in your terminal — and in your Telegram DMs.</b>
</p>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.4-000?logo=bun&logoColor=fff">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff">
  <img alt="AI SDK" src="https://img.shields.io/badge/AI%20SDK-v7-8b5cf6">
  <img alt="OpenRouter" src="https://img.shields.io/badge/OpenRouter-any%20model-a78bfa">
</p>

---

## What it is

CodeFang is a coding agent that reads your codebase, plans work, and edits files —
but **nothing it does touches your disk until you say so.**

Every mutation the model makes is written to an in-memory overlay and logged as a
pending action. When the run finishes you get a grouped, colour-coded diff and
decide what lands. Reject, and the staging area is simply thrown away.

```
  model calls modify_file ──▶ overlay (RAM) ──▶ you review the diff ──▶ disk
                                    │
                                    └── reject ──▶ discarded, nothing written
```

---

## Modes

CodeFang opens with a mode picker. Pick where you want to drive it from.

### ▼ Agent
Give it a task. It explores, stages edits, and hands you a diff to approve.
Up to 40 tool steps.

### ▼ Plan
Give it a goal. It researches the codebase (read-only, plus the web if you have a
Firecrawl key) and returns a structured 1–15 step plan with complexity tags.
Tick the steps you want, and it executes only those — then one approval covers
everything the run staged.

### ▼ Ask
Questions about the codebase, read-only. No file tools are exposed to the model
at all. Optionally save the answer as a Markdown file.

### ▼ Telegram
The same three flows, driven from chat with `/ask`, `/agent`, and `/plan`.
Plans get tappable inline checkboxes; staged changes get **Show Diff**,
**Review one by one**, and **Accept / Reject All** buttons. Locked to a single
owner chat ID.

---

## Quick start

```bash
bun install
cp .env.example .env     # then fill it in (see below)
bun start                # or: bun run index.ts wakeup
```

Once linked (`bun link`), the CLI is available as `codefang`:

```bash
codefang            # banner + mode picker
codefang wakeup     # same thing, explicitly
codefang --help
```

---

## Configuration

Create a `.env` in the project root:

| Variable | Required | Purpose |
| --- | :---: | --- |
| `OPENROUTER_API_KEY` | ✅ | Your [OpenRouter](https://openrouter.ai) key. |
| `OPENROUTER_DEFAULT_MODEL` | ✅ | Model slug exactly as OpenRouter lists it, e.g. `openrouter/auto`. |
| `TELEGRAM_BOT_TOKEN` | Telegram | Bot token from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_OWNER_ID` | Telegram | Your chat ID. Every other sender is ignored. |
| `FIRECRAWL_API_KEY` | — | Optional. Unlocks the web research tools. |
| `SKILLS_DIRS` | — | Optional. Extra `SKILL.md` roots, `;`-separated. |

---

## Tools

| Tool | Does | Effect |
| --- | --- | --- |
| `read_file` | Read one text file | reads |
| `list_files` | List a directory, optionally recursive | reads |
| `search_files` | Glob match, optional content filter | reads |
| `analyze_codebase` | File and directory counts | reads |
| `list_skills` / `read_skill` | Discover and read `SKILL.md` files | reads |
| `create_file` | New file | **staged** |
| `modify_file` | Full-file replacement | **staged** |
| `delete_file` | Remove a file | **staged** |
| `create_folder` | `mkdir -p` on apply | **staged** |
| `execute_shell` | Queue a command | **staged** |
| `web_search` | Firecrawl search | network |
| `web_crawl` | Scrape a URL to Markdown | network |
| `fetch_url` | Plain HTTP GET | network |

Which modes get what:

| | read | write | shell | web |
| --- | :---: | :---: | :---: | :---: |
| Agent | ✅ | ✅ | ✅ | — |
| Plan (research) | ✅ | — | — | 🔑 |
| Plan (execution) | ✅ | ✅ | ✅ | 🔑 |
| Ask | ✅ | — | — | 🔑 |
| Telegram `/ask` | ✅ | — | — | 🔑 |
| Telegram `/agent`, `/plan` | ✅ | ✅ | ✅ | 🔑 |

🔑 = requires `FIRECRAWL_API_KEY`.

---

## Safety rails

- **Workspace jail** — every path resolves against the project root; `..` escapes throw.
- **Exclusions** — `node_modules`, `.git`, `dist`, `build`, `.next`, `*.log`, and `.env*` are invisible to every tool.
- **Read cap** — files over 1 MB are refused.
- **Nothing is written early** — creates, edits, deletes and folders live in RAM until approved.
- **Shell is queued, not run** — commands only execute after you approve them.
- **Telegram is single-owner** — every update from a chat other than `TELEGRAM_OWNER_ID` is dropped.
- **Skill reads are rooted** — `read_skill` refuses anything outside the configured skill directories.

---

## Project layout

```
index.ts                  CLI entry (commander)
ai/                       OpenRouter model factory
tui/
  theme.ts                colours, glyphs, layout helpers — the whole look
  banner.ts               wordmark + context box
  spinner.ts              braille spinner with swappable status labels
  agent-stream.ts         drives the spinner from a live agent stream
  terminal-md.ts          markdown → ANSI
modes/
  cli.ts                  sub-mode picker
  agent/
    orchestrator.ts       run the agent, then approve
    tool-executor.ts      the staging overlay + all tool implementations
    action-tracker.ts     append-only log of everything the agent did
    review-groups.ts      collapse pending actions into reviewable diffs
    approval.ts           the terminal approval flow
    diff-view.ts          unified patches
  plan/                   planner, step selection, web tools
  ask/                    read-only Q&A
  telegram/               bot, handlers, plan and approval sessions
```

---

## Scripts

```bash
bun start        # launch the CLI
bun run typecheck  # tsc --noEmit
```
