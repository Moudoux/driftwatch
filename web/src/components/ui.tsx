import { Check, Copy, Loader2, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}) {
  const variants: Record<Variant, string> = {
    primary:
      "text-ink-950 bg-gradient-to-br from-cyan-300 to-violet-400 hover:brightness-110 shadow-[0_0_0_1px_rgb(255_255_255/0.15)_inset,0_8px_24px_-8px_rgb(34_211_238/0.5)]",
    secondary: "bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1] ring-1 ring-inset ring-white/10",
    ghost: "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]",
    danger: "bg-red-500/10 text-red-300 hover:bg-red-500/20 ring-1 ring-inset ring-red-500/30",
  };
  const sizes = {
    sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
    md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
    lg: "h-11 px-5 text-[15px] gap-2.5 rounded-xl",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
        "disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        "inline-flex size-8 items-center justify-center rounded-lg transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
        active
          ? "bg-cyan-400/15 text-cyan-300 ring-1 ring-inset ring-cyan-400/30"
          : "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100",
        "disabled:opacity-40 disabled:pointer-events-none",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Input({
  className,
  icon,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  return (
    <div className={cx("relative", className)}>
      {icon && (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-500">
          {icon}
        </span>
      )}
      <input
        {...rest}
        className={cx(
          "h-9 w-full rounded-lg bg-white/[0.04] text-sm text-zinc-100 placeholder:text-zinc-500",
          "ring-1 ring-inset ring-white/10 transition focus:bg-white/[0.06] focus:outline-none focus:ring-cyan-400/50",
          icon ? "pl-9 pr-3" : "px-3",
        )}
      />
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium tracking-wide text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-zinc-500", className)} />;
}

export function StatusDot({ online, pulse }: { online: boolean; pulse?: boolean }) {
  return (
    <span
      className={cx(
        "inline-block size-2 shrink-0 rounded-full",
        online ? "bg-emerald-400" : "bg-red-400/80",
        online && pulse && "animate-pulse-ring",
      )}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "red" | "amber" | "cyan" | "violet";
  className?: string;
}) {
  const tones = {
    neutral: "bg-white/[0.06] text-zinc-300 ring-white/10",
    green: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25",
    red: "bg-red-400/10 text-red-300 ring-red-400/25",
    amber: "bg-amber-400/10 text-amber-300 ring-amber-400/25",
    cyan: "bg-cyan-400/10 text-cyan-300 ring-cyan-400/25",
    violet: "bg-violet-400/10 text-violet-300 ring-violet-400/25",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        "rounded-2xl bg-ink-800/80 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgb(255_255_255/0.04)_inset]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="fixed inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "relative mt-[6vh] w-full animate-pop-in rounded-2xl bg-ink-800 ring-1 ring-white/10",
          "shadow-[0_24px_80px_-12px_rgb(0_0_0/0.8)]",
          wide ? "max-w-3xl" : "max-w-md",
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-6 py-5">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
            {description && <p className="mt-1 text-sm text-zinc-400">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return [copied, copy];
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <Button
      size="sm"
      variant={copied ? "secondary" : "ghost"}
      onClick={() => copy(text)}
      icon={copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function CodeBlock({
  code,
  filename,
  maxHeight = "22rem",
}: {
  code: string;
  filename?: string;
  maxHeight?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-ink-950 ring-1 ring-white/[0.08]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
        <span className="font-mono text-xs text-zinc-500">{filename}</span>
        <CopyButton text={code} />
      </div>
      <pre
        className="overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-zinc-300"
        style={{ maxHeight }}
      >
        {code}
      </pre>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-inset ring-white/[0.08]">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={cx(
            "rounded-md px-3 py-1 text-xs font-medium transition",
            value === it.value ? "bg-white/[0.1] text-zinc-100 shadow-sm" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-inset ring-red-500/25">
      {error}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-white/[0.04] text-zinc-400 ring-1 ring-white/10">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-px font-mono text-[10px] text-zinc-400">
      {children}
    </kbd>
  );
}
