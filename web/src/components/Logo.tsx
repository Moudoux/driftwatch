import { cx } from "./ui";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx("size-8", className)} aria-hidden>
      <defs>
        <linearGradient id="dw-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#0d1117" stroke="rgb(255 255 255 / 0.08)" />
      <path
        d="M7 11c3-3 6-3 9 0s6 3 9 0M7 16c3-3 6-3 9 0s6 3 9 0M7 21c3-3 6-3 9 0s6 3 9 0"
        fill="none"
        stroke="url(#dw-g)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-zinc-100">Driftwatch</span>
    </div>
  );
}
