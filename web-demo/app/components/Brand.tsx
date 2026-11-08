type FangProps = { className?: string; title?: string };

/** The ▼ mark, drawn so it renders identically everywhere. */
export function Fang({ className, title }: FangProps) {
  return (
    <svg className={className} viewBox="0 0 12 11" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d="M0.5 0.5h11L6 10.5z" fill="currentColor" />
    </svg>
  );
}

type LogoProps = { className?: string };

/** Typographic wordmark: the ▼ mark beside "CodeFang" set in the display face. */
export function Logo({ className }: LogoProps) {
  return (
    <span className={`logo ${className ?? ""}`}>
      <Fang className="logo-mark" />
      <span className="logo-word">CodeFang</span>
    </span>
  );
}
