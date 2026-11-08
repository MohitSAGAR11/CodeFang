import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ClipboardCopy,
  Eye,
  FolderLock,
  Layers,
  ListChecks,
  MessageSquareText,
  SquareTerminal,
  Wand2,
} from "lucide-react";
import { useState } from "react";
import { AsciiField } from "./AsciiField.tsx";
import { Logo } from "./Brand.tsx";
import { OverlayDiagram } from "./OverlayDiagram.tsx";
import { Playground } from "./Playground.tsx";

const REPO_URL = "https://github.com/MohitSAGAR11/CodeFang";
const CLONE = "git clone https://github.com/MohitSAGAR11/CodeFang.git";

const FEATURES = [
  {
    Icon: Wand2,
    title: "Agent",
    body: "Give it a task. It explores the repo, stages edits in the overlay, and hands you a diff to approve.",
    tags: ["read", "write", "diff review"],
  },
  {
    Icon: ListChecks,
    title: "Plan",
    body: "Researches read-only and returns a 1–15 step plan. Tick the steps you want; one review covers them all.",
    tags: ["research", "checklist", "execute"],
  },
  {
    Icon: MessageSquareText,
    title: "Ask",
    body: "Questions about the codebase. No write tools are exposed to the model at all.",
    tags: ["read-only", "markdown"],
  },
  {
    Icon: Layers,
    title: "The overlay",
    body: "Every create, edit and delete lands in RAM first. The agent reads its own staged work back; disk never sees it early.",
    tags: ["staged", "read-back"],
  },
  {
    Icon: FolderLock,
    title: "Workspace jail",
    body: "Every path resolves against the project root; anything that climbs out with .. throws. .env, .git and node_modules stay invisible.",
    tags: ["paths", "exclusions"],
  },
  {
    Icon: SquareTerminal,
    title: "Shell is queued",
    body: "In your terminal, commands wait for approval like any edit. In this playground the shell doesn't exist at all.",
    tags: ["terminal: queued", "web: off"],
  },
];

const TICKER_A = [
  ["list_files", ".", "8 entries"],
  ["read_file", "src/backoff.ts", "30 lines"],
  ["search_files", "**/*.ts", "4 matches"],
  ["modify_file", "src/backoff.ts", "staged +4 −5"],
  ["create_file", "test/cap.test.ts", "staged +9"],
  ["review", "2 files", "waiting for you"],
];
const TICKER_B = [
  ["approve", "src/backoff.ts", "written"],
  ["reject", "test/cap.test.ts", "discarded"],
  ["read_file", "ledger/store.py", "52 lines"],
  ["plan", "add a budget command", "3 steps"],
  ["execute_shell", "bun test", "queued until approved"],
  ["delete_file", "README.old.md", "staged"],
];

function Ticker() {
  const row = (items: string[][], dir: "left" | "right") => (
    <div className={`ticker-row ticker-${dir}`}>
      {[...items, ...items].map(([tool, arg, note], i) => (
        <span key={i} className="ticker-item" data-tool={tool} aria-hidden={i >= items.length || undefined}>
          <span className="ticker-tool">{tool}</span>
          <span className="ticker-arg">{arg}</span>
          <span className="ticker-note">{note}</span>
        </span>
      ))}
    </div>
  );
  return (
    <div className="ticker" aria-label="Example tool calls from a run">
      {row(TICKER_A, "left")}
      {row(TICKER_B, "right")}
    </div>
  );
}

function QuickStart() {
  const [tab, setTab] = useState<"web" | "terminal">("web");
  return (
    <div className="qs">
      <div className="qs-tabs" role="tablist" aria-label="Ways to try CodeFang">
        <span className="qs-label">Try it</span>
        <button type="button" role="tab" aria-selected={tab === "web"} onClick={() => setTab("web")}>
          In the browser
        </button>
        <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => setTab("terminal")}>
          In your terminal
        </button>
      </div>
      {tab === "web" ? (
        <div className="qs-body" role="tabpanel">
          <h3>A throwaway repo, the real agent</h3>
          <p>Pick a sample repo, run a mode, watch every tool call stream in, then approve or reject each file.</p>
          <ol className="qs-steps">
            <li><span>01</span> Pick <code>retry-kit</code>, <code>ledger</code> or <code>shorty</code>, or import a small public repo.</li>
            <li><span>02</span> Run Agent with one of the suggested tasks.</li>
            <li><span>03</span> Review the diff file by file, apply, download the <code>.patch</code>.</li>
          </ol>
          <a className="btn btn-primary" href="#playground">
            Open the playground <ArrowDown aria-hidden size={15} />
          </a>
        </div>
      ) : (
        <div className="qs-body" role="tabpanel">
          <h3>Bun, an OpenRouter key, and your repo</h3>
          <p>The terminal app adds Telegram mode, queued shell commands and optional web research.</p>
          <pre className="qs-code">
            <code>
              <span className="qs-prompt">$</span> bun install{"\n"}
              <span className="qs-prompt">$</span> cp .env.example .env{"   "}<span className="qs-comment"># OPENROUTER_API_KEY, model</span>{"\n"}
              <span className="qs-prompt">$</span> bun start
            </code>
          </pre>
          <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Read the README <ArrowUpRight aria-hidden size={15} />
          </a>
        </div>
      )}
    </div>
  );
}

function CloneRow() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CLONE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="clone">
      <label htmlFor="clone-cmd">Get the terminal app</label>
      <div className="clone-row">
        <input id="clone-cmd" readOnly value={CLONE} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy clone command"}>
          {copied ? <Check aria-hidden size={18} /> : <ClipboardCopy aria-hidden size={18} />}
        </button>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <>
      <header className="topbar">
        <a className="topbar-brand" href="#top" aria-label="CodeFang home">
          <Logo />
        </a>
        <nav aria-label="Main">
          <a href="#overlay" className="nav-hide-sm">How it works</a>
          <a href="#modes" className="nav-hide-sm">Modes</a>
          <a href="#playground">Playground</a>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub <ArrowUpRight aria-hidden size={13} />
          </a>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <AsciiField />
          <p className="hero-kicker">
            <span>Open source</span>
            <span>Runs in your terminal</span>
            <span>Nothing lands unreviewed</span>
          </p>
          <h1 id="hero-title">
            Nothing touches disk until <em>you</em> say&nbsp;so.
          </h1>
          <p className="hero-lede">
            CodeFang reads your codebase, plans the work, and edits files.
            <br className="br-lg" /> Every edit lands in an in-memory overlay first.
            <br className="br-lg" /> You review the diff, file by file, and decide what's real.
          </p>
          <p className="hero-trace">read_file · modify_file · staged · reviewed · written</p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#playground">Open the playground</a>
            <a className="btn btn-ghost" href="#overlay">How the overlay works</a>
            <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              Source on GitHub
            </a>
          </div>
        </section>

        <div className="rail">
          <section className="rail-section" aria-labelledby="qs-title">
            <h2 id="qs-title" className="label">Quick start</h2>
            <QuickStart />
          </section>

          <section id="overlay" className="rail-section" aria-labelledby="overlay-title">
            <h2 className="label">How it works</h2>
            <div className="section-head">
              <h3 id="overlay-title">The overlay sits between the model and your disk.</h3>
              <p>
                Mid-run, the overlay is the source of truth: a staged file reads back as the staged version, and a file staged for
                deletion reads back as gone. Approve, and it's written. Reject, and it's thrown away.
              </p>
            </div>
            <OverlayDiagram />
          </section>

          <section className="rail-section" aria-labelledby="ticker-title">
            <h2 id="ticker-title" className="label">A run, as it streams</h2>
            <Ticker />
          </section>

          <section id="modes" className="rail-section" aria-labelledby="modes-title">
            <h2 id="modes-title" className="label">What it does</h2>
            <div className="features">
              {FEATURES.map(({ Icon, title, body, tags }) => (
                <article key={title} className="feature">
                  <Icon aria-hidden size={20} strokeWidth={1.6} className="feature-icon" />
                  <h3 className="feature-title">{title}</h3>
                  <p className="feature-body">{body}</p>
                  <p className="feature-tags">
                    {tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <section id="playground" className="pg-band" aria-labelledby="playground-title">
          <div className="pg-band-inner">
            <div className="pg-band-head">
              <h2 className="label">Playground</h2>
              <h3 id="playground-title">Run the real agent on a throwaway repo.</h3>
              <p>
                The repo lives in this server's memory: no shell, no network, nothing persists. The shared key runs a free model,
                so expect some lag; bring your own OpenRouter key for faster ones.
              </p>
            </div>
            <Playground />
          </div>
        </section>

        <div className="rail">
          <section className="rail-section promise" aria-labelledby="promise-title">
            <h2 className="label">The promise</h2>
            <div className="promise-body">
              <h3 id="promise-title">
                Nothing lands without review. <span>Everything else is just a diff you haven't approved yet.</span>
              </h3>
              <CloneRow />
            </div>
          </section>

          <section className="rail-section rail-last" aria-labelledby="eyes-title">
            <h2 id="eyes-title" className="label">Who it's for</h2>
            <p className="closing">
              <Eye aria-hidden size={18} strokeWidth={1.6} />
              <span>
                People who want an agent's speed without handing it the keys. Read every change before it exists, keep the ones you
                like, and take a <code>.patch</code> with you.
              </span>
            </p>
            <a className="section-link" href="#playground">
              Try it now <ArrowRight aria-hidden size={14} />
            </a>
          </section>
        </div>
      </main>

      <footer className="footer">
        <Logo />
        <span>Built with Bun, the AI SDK and OpenRouter.</span>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Source <ArrowUpRight aria-hidden size={13} />
        </a>
      </footer>
    </>
  );
}
