import { useEffect, useRef } from "react";
import { Fang } from "./Brand.tsx";

const RAMP = " .:-=+x*#%@";
const FPS = 14;
const CHAR_W = 7.6; // 11px mono + 1px tracking
const LINE_H = 14.3;

/**
 * A field of characters with rings radiating out of the ▼ mark, like a
 * change propagating out of the overlay. Plain text in a <pre>, redrawn at a
 * low frame rate, paused off-screen, and drawn once for reduced motion.
 */
export function AsciiField() {
  const host = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = host.current;
    const out = pre.current;
    if (!el || !out) return;

    let cols = 0;
    let rows = 0;
    let visible = true;
    let raf = 0;
    let last = 0;
    const started = performance.now();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const measure = () => {
      cols = Math.ceil(el.clientWidth / CHAR_W) + 2;
      rows = Math.max(8, Math.floor(el.clientHeight / LINE_H));
    };

    const frame = (t: number) => {
      const time = still ? 4.2 : t / 1000;
      const cx = cols / 2;
      const cy = rows - 1.5;
      // Rows are stretched so rings read as wide, flat arcs across the field.
      const yScale = Math.max(4, (cols * 0.42) / rows);
      const maxR = Math.hypot(cx, rows * yScale);
      const spacing = maxR / 5;
      const phase = (time * 5) % spacing;
      let text = "";
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const dx = x - cx;
          const dy = (y - cy) * yScale;
          const d = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          let v = 0;
          for (let k = 0; k < 5; k++) {
            const r = phase + k * spacing;
            const w = 1.4 + r * 0.03;
            v += Math.exp(-((d - r) ** 2) / (2 * w * w)) * (1 - r / (maxR * 1.15));
          }
          // Break rings into arcs that drift, so it reads as motion, not a target.
          v *= 0.62 + 0.38 * Math.sin(angle * 4 - time * 0.5 + d * 0.03);
          // A sparse background lattice of dots.
          const lattice = x % 6 === 0 && y % 2 === 0 ? 0.09 : 0;
          const level = Math.max(v, lattice);
          const idx = Math.min(RAMP.length - 1, Math.floor(level * (RAMP.length - 0.01)));
          text += RAMP[idx];
        }
        text += "\n";
      }
      out.textContent = text;
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || t - last < 1000 / FPS) return;
      last = t;
      frame(t - started);
    };

    const ro = new ResizeObserver(() => {
      measure();
      frame(performance.now() - started);
    });
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    io.observe(el);

    measure();
    frame(0);
    if (!still) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return (
    <div className="ascii" ref={host} aria-hidden>
      <pre ref={pre} className="ascii-pre" />
      <Fang className="ascii-fang" />
    </div>
  );
}
