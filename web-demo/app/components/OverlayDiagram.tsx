import { Check, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Phase = "idle" | "model" | "overlay" | "review" | "disk" | "discarded";
type Station = "model" | "overlay" | "review" | "disk" | "discarded";

const STATION_OF: Record<Phase, Station> = {
  idle: "model",
  model: "model",
  overlay: "overlay",
  review: "review",
  disk: "disk",
  discarded: "discarded",
};

const CHIP_LABEL: Record<Phase, string> = {
  idle: "modify_file",
  model: "modify_file",
  overlay: "staged",
  review: "staged",
  disk: "written",
  discarded: "discarded",
};

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The README's pipeline, made live: a staged edit travels from the model into
 * the overlay and waits at the review gate until the visitor decides.
 */
export function OverlayDiagram() {
  const root = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const anchors = useRef<Partial<Record<Station, HTMLElement | null>>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const play = useCallback(() => {
    clearTimers();
    const fast = reducedMotion();
    setPhase("model");
    timers.current.push(window.setTimeout(() => setPhase("overlay"), fast ? 0 : 700));
    timers.current.push(window.setTimeout(() => setPhase("review"), fast ? 0 : 1900));
  }, []);

  // Start once the diagram scrolls into view.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          play();
          io.disconnect();
        }
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimers();
    };
  }, [play]);

  // Position the chip over its current station (layout differs on mobile).
  const measure = useCallback(() => {
    const box = root.current?.getBoundingClientRect();
    const target = anchors.current[STATION_OF[phase]]?.getBoundingClientRect();
    const c = chip.current?.getBoundingClientRect();
    if (!box || !target || !c) return;
    setPos({
      x: target.left - box.left + target.width / 2 - c.width / 2,
      y: target.top - box.top + target.height - c.height / 2,
    });
  }, [phase]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const ro = new ResizeObserver(() => measure());
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, [measure]);

  const station = (name: Station) => (el: HTMLElement | null) => {
    anchors.current[name] = el;
  };
  const deciding = phase === "review";
  const decided = phase === "disk" || phase === "discarded";

  return (
    <div className="diagram" ref={root} data-phase={phase}>
      <ol className="diagram-track">
        <li className="station station-model" ref={station("model")}>
          <span className="station-name">model</span>
          <span className="station-note">Decides on an edit and calls a write tool.</span>
          <code className="station-call">modify_file("src/backoff.ts", …)</code>
        </li>
        <li className="station station-overlay" ref={station("overlay")}>
          <span className="station-name">overlay <span className="station-tag">RAM</span></span>
          <span className="station-note">The agent reads its own staged edit back. Disk hasn't changed.</span>
        </li>
        <li className="station station-review" ref={station("review")}>
          <span className="station-name">your review</span>
          <pre className="mini-diff" aria-label="Staged diff for src/backoff.ts">
            <span className="mini-del">- return capped + jitter</span>
            <span className="mini-add">+ return Math.min(max, capped + jitter)</span>
          </pre>
          <div className="station-actions">
            <button type="button" className="btn btn-approve btn-sm" disabled={!deciding} onClick={() => setPhase("disk")}>
              <Check aria-hidden size={14} strokeWidth={2.5} /> Approve
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!deciding} onClick={() => setPhase("discarded")}>
              <X aria-hidden size={14} strokeWidth={2.5} /> Reject
            </button>
          </div>
        </li>
        <li className="station station-disk" ref={station("disk")}>
          <span className="station-name">disk</span>
          <span className="station-note">{phase === "disk" ? "src/backoff.ts written." : "Only approved changes are written."}</span>
        </li>
      </ol>
      <div className="station station-discarded" ref={station("discarded")}>
        <span className="station-name">discarded</span>
        <span className="station-note">{phase === "discarded" ? "Thrown away. Nothing was written." : "Reject, and the staging is thrown away."}</span>
      </div>

      <div
        ref={chip}
        className="diagram-chip"
        data-phase={phase}
        aria-hidden
        style={pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : { visibility: "hidden" }}
      >
        <span className="chip-verb">{CHIP_LABEL[phase]}</span> src/backoff.ts
      </div>

      <p className="diagram-status" aria-live="polite">
        {deciding && "The edit is waiting for you. Approve it or reject it."}
        {phase === "disk" && "Approved: the change is now real."}
        {phase === "discarded" && "Rejected: the overlay was cleared and the file is untouched."}
      </p>
      {decided && (
        <button type="button" className="btn btn-ghost btn-sm diagram-replay" onClick={play}>
          <RotateCcw aria-hidden size={14} /> Run it again
        </button>
      )}
    </div>
  );
}
