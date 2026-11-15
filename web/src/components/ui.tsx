import { Check, Copy, Loader2, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useRef,
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
    primary: "bg-fg text-canvas hover:opacity-90",
    secondary: "border border-line-strong bg-raised text-fg hover:bg-hover",
    ghost: "text-fg-muted hover:bg-hover hover:text-fg",
    danger: "bg-bad text-white hover:opacity-90",
  };
  const sizes = {
    sm: "h-7 px-2.5 text-xs gap-1.5",
    md: "h-8 px-3 text-[13px] gap-1.5",
    lg: "h-10 px-4 text-sm gap-2",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-[background-color,opacity,color] duration-100",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
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
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-100",
        active ? "bg-active text-fg" : "text-fg-faint hover:bg-hover hover:text-fg",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

const fieldBase =
  "w-full rounded-md border border-line-strong bg-raised text-fg placeholder:text-fg-faint transition-colors duration-100 focus:border-accent focus:outline-none";

export function Input({
  className,
  icon,
  trailing,
  ...rest
}: ComponentProps<"input"> & { icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className={cx("relative", className)}>
      {icon && (
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-fg-faint">{icon}</span>
      )}
      <input
        {...rest}
        className={cx(fieldBase, "h-8 text-[13px]", icon ? "pl-8" : "pl-2.5", trailing ? "pr-10" : "pr-2.5")}
      />
      {trailing && (
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">{trailing}</span>
      )}
    </div>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(fieldBase, "h-7 px-2 text-xs", className)}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-fg-faint">{hint}</span>}
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-4 animate-spin text-fg-faint", className)} />;
}

export function StatusDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      aria-label={online ? "online" : "offline"}
      className={cx("inline-block size-1.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-bad", className)}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "bad" | "warn" | "accent";
  className?: string;
}) {
  const tones = {
    neutral: "text-fg-muted border-line-strong",
    ok: "text-ok border-ok/30",
    bad: "text-bad border-bad/30",
    warn: "text-warn border-warn/30",
    accent: "text-accent border-accent/30",
  };
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded border px-1.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-lg border border-line bg-raised", className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-line px-5 pt-6 sm:px-8 sm:pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1 text-[13px] text-fg-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 max-w-2xl text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-3 sm:p-8">
      <div className="fixed inset-0 animate-fade-in bg-overlay" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "relative mt-[4vh] w-full animate-rise rounded-lg border border-line-strong bg-raised shadow-lg sm:mt-[8vh]",
          wide ? "max-w-3xl" : "max-w-md",
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
            {description && <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-1.5">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 pb-5 pt-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-1">{children}</div>;
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
      variant="ghost"
      onClick={() => copy(text)}
      icon={copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
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
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex h-9 items-center justify-between border-b border-line pl-3 pr-1">
        <span className="font-mono text-xs text-fg-faint">{filename}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-fg" style={{ maxHeight }}>
        {code}
      </pre>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cx("inline-flex h-7 shrink-0 rounded-md border border-line-strong p-0.5", className)}>
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          aria-pressed={value === it.value}
          className={cx(
            "rounded-[4px] px-2 text-xs font-medium transition-colors duration-100",
            value === it.value ? "bg-active text-fg" : "text-fg-faint hover:text-fg",
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
  return <div className="rounded-md border border-bad/25 bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</div>;
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
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 text-fg-faint">{icon}</div>
      <h3 className="text-sm font-medium text-fg">{title}</h3>
      {children && <div className="mt-1 max-w-sm text-[13px] text-fg-muted">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong px-1 font-sans text-[10px] leading-4 text-fg-faint">
      {children}
    </kbd>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-sunken px-1 py-px font-mono text-[0.92em] text-fg">{children}</code>;
}
