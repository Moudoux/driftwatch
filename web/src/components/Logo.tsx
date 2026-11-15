import { cx } from "./ui";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx("size-6", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-fg" />
      <path
        d="M8 12c2.7-2.7 5.3-2.7 8 0s5.3 2.7 8 0M8 16.5c2.7-2.7 5.3-2.7 8 0s5.3 2.7 8 0M8 21c2.7-2.7 5.3-2.7 8 0s5.3 2.7 8 0"
        fill="none"
        className="stroke-canvas"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <span className="text-sm font-semibold tracking-tight text-fg">Driftwatch</span>
    </div>
  );
}
