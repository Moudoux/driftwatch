import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  Clock,
  Download,
  Eraser,
  Layers,
  Pause,
  Play,
  Search,
  Server,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseAnsi, stripAnsi } from "../lib/ansi";
import { logsUrl } from "../lib/api";
import { isoTime, logTime, stateColor, tagColor } from "../lib/format";
import type { ContainerInfo, LogEvent, Machine } from "../lib/types";
import { Badge, cx, IconButton, Kbd } from "./ui";

const MAX_LINES = 50_000;
const TAILS = [100, 500, 1000, 5000, 20000];

interface Line {
  seq: number;
  /** Container id, or "" for stream-wide notices. */
  c: string;
  /** stdout, stderr, or a meta notice. */
  s: "o" | "e" | "m";
  t: number;
  m: string;
  /** Plain text, for filtering. */
  plain: string;
  tone?: "good" | "bad" | "info";
}

type Conn = "connecting" | "live" | "reconnecting" | "ended";

function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [v, set];
}

function describeState(state: string, msg?: string): { text: string; tone: Line["tone"] } | null {
  switch (state) {
    case "running":
      return { text: "Container started", tone: "good" };
    case "exited":
    case "dead":
      return { text: `Container stopped (${state})`, tone: "bad" };
    case "paused":
      return { text: "Container paused", tone: "info" };
    case "restarting":
      return { text: "Container restarting", tone: "info" };
    case "removed":
      return { text: "Container removed", tone: "bad" };
    case "connected":
      return { text: "Reconnected to agent", tone: "good" };
    case "disconnected":
    case "unreachable":
      return { text: `Lost connection to agent${msg ? `: ${msg}` : ""} — retrying`, tone: "bad" };
    case "error":
      return { text: `Error${msg ? `: ${msg}` : ""}`, tone: "bad" };
    default:
      return null;
  }
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={n++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  out.push(text.slice(i));
  return <>{out}</>;
}

const Message = memo(function Message({ m, q }: { m: string; q: string }) {
  if (q) return <Highlight text={stripAnsi(m)} q={q} />;
  return (
    <>
      {parseAnsi(m).map((seg, i) =>
        seg.fg || seg.bg || seg.bold || seg.dim || seg.italic || seg.underline ? (
          <span
            key={i}
            style={{
              color: seg.fg,
              backgroundColor: seg.bg,
              fontWeight: seg.bold ? 700 : undefined,
              opacity: seg.dim ? 0.6 : undefined,
              fontStyle: seg.italic ? "italic" : undefined,
              textDecoration: seg.underline ? "underline" : undefined,
            }}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
});

export function LogViewer({
  machine,
  containers,
  title,
  project,
}: {
  machine: Machine;
  containers: ContainerInfo[];
  title: string;
  project?: string;
}) {
  const ids = useMemo(() => containers.map((c) => c.id).sort(), [containers]);
  const idsKey = ids.join(",");
  const multi = ids.length > 1;
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of containers) m.set(c.id, c.project && c.service ? c.service : c.name);
    return m;
  }, [containers]);
  const nameWidth = useMemo(
    () => Math.min(22, Math.max(6, ...[...names.values()].map((n) => n.length))),
    [names],
  );

  const [tail, setTail] = useStored("dw:tail", 500);
  const [wrap, setWrap] = useStored("dw:wrap", true);
  const [showTs, setShowTs] = useStored("dw:ts", true);
  const [filter, setFilter] = useState("");
  const [streamFilter, setStreamFilter] = useState<"all" | "o" | "e">("all");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [conn, setConn] = useState<Conn>("connecting");
  const [version, setVersion] = useState(0);
  const [follow, setFollow] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const linesRef = useRef<Line[]>([]);
  const pendingRef = useRef<Line[]>([]);
  const pausedRef = useRef(paused);
  const seqRef = useRef(0);
  const lastTRef = useRef<number | undefined>(undefined);
  const statesRef = useRef(new Map<string, string>());
  const frameRef = useRef<number | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);

  const flush = useCallback(() => {
    frameRef.current = null;
    if (pausedRef.current || pendingRef.current.length === 0) {
      setPendingCount(pendingRef.current.length);
      return;
    }
    const lines = linesRef.current;
    const incoming = pendingRef.current;
    pendingRef.current = [];
    const lastBefore = lines.length ? lines[lines.length - 1].t : -Infinity;
    let outOfOrder = false;
    for (const l of incoming) {
      if (l.t < lastBefore) outOfOrder = true;
      lines.push(l);
    }
    if (outOfOrder) lines.sort((a, b) => a.t - b.t || a.seq - b.seq);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    setPendingCount(0);
    setVersion((v) => v + 1);
  }, []);

  const schedule = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) schedule();
  }, [paused, schedule]);

  // Connect to the SSE stream; reconnect with `since` so nothing is replayed.
  useEffect(() => {
    linesRef.current = [];
    pendingRef.current = [];
    lastTRef.current = undefined;
    statesRef.current = new Map();
    setVersion((v) => v + 1);
    setConn("connecting");
    setFollow(true);
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const meta = (text: string, tone: Line["tone"], c = "") => {
      const t = lastTRef.current ?? Date.now() * 1000;
      pendingRef.current.push({ seq: seqRef.current++, c, s: "m", t, m: text, plain: text, tone });
    };

    const ingest = (events: LogEvent[]) => {
      for (const ev of events) {
        if (ev.k === "l") {
          lastTRef.current = Math.max(lastTRef.current ?? 0, ev.t);
          pendingRef.current.push({ seq: seqRef.current++, c: ev.c, s: ev.s, t: ev.t, m: ev.m, plain: stripAnsi(ev.m).toLowerCase() });
        } else {
          const prev = statesRef.current.get(ev.c);
          statesRef.current.set(ev.c, ev.state);
          // The first state per container is just its current state.
          if (prev === undefined && ev.c !== "*") continue;
          if (prev === ev.state) continue;
          const d = describeState(ev.state, ev.msg);
          if (d) meta(multi && ev.c !== "*" ? `${names.get(ev.c) ?? ev.c}: ${d.text}` : d.text, d.tone, ev.c === "*" ? "" : ev.c);
        }
      }
      if (pendingRef.current.length > MAX_LINES) pendingRef.current.splice(0, pendingRef.current.length - MAX_LINES);
      schedule();
    };

    const open = (since?: number) => {
      es = new EventSource(logsUrl(machine.id, ids, tail, since));
      es.onopen = () => setConn("live");
      es.addEventListener("logs", (e) => ingest(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("end", () => {
        es?.close();
        setConn("ended");
        meta("Stream ended — the container no longer exists", "info");
        schedule();
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        setConn("reconnecting");
        retry = setTimeout(() => open(lastTRef.current !== undefined ? lastTRef.current + 1 : undefined), 3000);
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(retry);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id, idsKey, tail]);

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    const lines = linesRef.current;
    if (!q && streamFilter === "all" && hidden.size === 0) return lines.slice();
    return lines.filter(
      (l) =>
        (l.s === "m" || streamFilter === "all" || l.s === streamFilter) &&
        (!l.c || !hidden.has(l.c)) &&
        (!q || l.plain.includes(q)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, q, streamFilter, hidden]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 40,
  });

  useLayoutEffect(() => {
    if (follow && visible.length) virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
  }, [visible, follow, virtualizer, wrap]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (atBottom) setFollow(true);
    else if (el.scrollTop < lastScrollTop.current - 2) setFollow(false);
    lastScrollTop.current = el.scrollTop;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showDate = useMemo(() => {
    const lines = linesRef.current;
    if (!lines.length) return false;
    const start = new Date(lines[0].t / 1000);
    const now = new Date();
    return start.toDateString() !== now.toDateString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const download = () => {
    const text = visible
      .map((l) =>
        l.s === "m"
          ? `--- ${l.m} ---`
          : `${isoTime(l.t)}${multi ? ` ${names.get(l.c) ?? l.c}` : ""}${l.s === "e" ? " [stderr]" : ""} ${stripAnsi(l.m)}`,
      )
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain" }));
    a.download = `${title.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const clear = () => {
    linesRef.current = [];
    setVersion((v) => v + 1);
  };

  const single = !multi ? containers[0] : undefined;
  const total = linesRef.current.length;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Server className="size-3.5" />
            <span>{machine.name}</span>
            {project && single && (
              <>
                <span className="text-zinc-700">/</span>
                <a href={`#/m/${encodeURIComponent(machine.id)}/p/${encodeURIComponent(project)}`} className="hover:text-zinc-300">
                  {project}
                </a>
              </>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            {multi ? (
              <Layers className="size-4 text-violet-300" />
            ) : (
              <span className={cx("size-2 rounded-full", stateColor(single?.state ?? ""))} />
            )}
            <h1 className="truncate text-[15px] font-semibold text-zinc-100">{title}</h1>
            {single && (
              <span className="hidden truncate font-mono text-xs text-zinc-500 md:inline">{single.image}</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ConnBadge conn={conn} paused={paused} online={machine.online} />
        </div>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-ink-850/50 px-3 py-2">
        <div className="relative w-full max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder="Filter lines"
            className="h-8 w-full rounded-lg bg-white/[0.04] pl-8 pr-9 text-[13px] text-zinc-100 ring-1 ring-inset ring-white/[0.08] placeholder:text-zinc-500 focus:outline-none focus:ring-cyan-400/40"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
            <Kbd>/</Kbd>
          </span>
        </div>
        <div className="inline-flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-inset ring-white/[0.08]">
          {(["all", "o", "e"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStreamFilter(s)}
              className={cx(
                "rounded-md px-2.5 py-1 text-xs font-medium transition",
                streamFilter === s ? "bg-white/[0.1] text-zinc-100" : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              {s === "all" ? "All" : s === "o" ? "stdout" : "stderr"}
            </button>
          ))}
        </div>
        <div className="mx-1 h-5 w-px bg-white/[0.08]" />
        <IconButton label="Timestamps" active={showTs} onClick={() => setShowTs(!showTs)}>
          <Clock className="size-4" />
        </IconButton>
        <IconButton label="Wrap lines" active={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText className="size-4" />
        </IconButton>
        <IconButton label={paused ? "Resume" : "Pause"} active={paused} onClick={() => setPaused(!paused)}>
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </IconButton>
        <IconButton label="Clear" onClick={clear}>
          <Eraser className="size-4" />
        </IconButton>
        <IconButton label="Download visible lines" onClick={download} disabled={!visible.length}>
          <Download className="size-4" />
        </IconButton>
        <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          History
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            className="h-8 rounded-lg bg-white/[0.04] px-2 text-xs text-zinc-200 ring-1 ring-inset ring-white/[0.08] focus:outline-none"
          >
            {TAILS.map((t) => (
              <option key={t} value={t} className="bg-ink-800">
                {t.toLocaleString()} lines
              </option>
            ))}
          </select>
        </label>
      </div>

      {multi && (
        <div className="flex flex-wrap gap-1.5 border-b border-white/[0.06] px-3 py-2">
          {containers.map((c) => {
            const off = hidden.has(c.id);
            const color = tagColor(names.get(c.id) ?? c.id);
            return (
              <button
                key={c.id}
                onClick={() =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (n.has(c.id)) n.delete(c.id);
                    else n.add(c.id);
                    return n;
                  })
                }
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition",
                  off ? "text-zinc-600 ring-white/[0.06]" : "text-zinc-200 ring-white/[0.12] bg-white/[0.04]",
                )}
                title={off ? "Show" : "Hide"}
              >
                <span className="size-1.5 rounded-full" style={{ background: off ? "#3f3f46" : color }} />
                {names.get(c.id)}
                {c.state !== "running" && <span className="text-zinc-500">· {c.state}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Lines */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-auto bg-ink-900 py-2">
          {visible.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-600">
              {conn === "connecting" ? "Connecting…" : q ? "No lines match your filter" : "Waiting for log output…"}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative", minWidth: wrap ? undefined : "max-content" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const l = visible[item.index];
                return (
                  <div
                    key={l.seq}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {l.s === "m" ? (
                      <MetaRow line={l} />
                    ) : (
                      <div
                        className={cx(
                          "log-row flex gap-3 border-l-2 px-4 font-mono text-[12.5px] leading-5 hover:bg-white/[0.03]",
                          l.s === "e" ? "border-red-500/50 bg-red-500/[0.035]" : "border-transparent",
                        )}
                      >
                        {showTs && (
                          <span className="shrink-0 select-none tabular-nums text-zinc-600">{logTime(l.t, showDate)}</span>
                        )}
                        {multi && (
                          <span
                            className="shrink-0 truncate select-none"
                            style={{ color: tagColor(names.get(l.c) ?? l.c), width: `${nameWidth}ch` }}
                          >
                            {names.get(l.c) ?? l.c.slice(0, 12)}
                          </span>
                        )}
                        <span
                          className={cx(
                            "min-w-0 text-zinc-300",
                            wrap ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "whitespace-pre",
                          )}
                        >
                          <Message m={l.m} q={q} />
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {(!follow || (paused && pendingCount > 0)) && visible.length > 0 && (
          <button
            onClick={() => {
              setPaused(false);
              setFollow(true);
            }}
            className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 animate-pop-in items-center gap-2 rounded-full bg-ink-700/95 px-4 py-2 text-xs font-medium text-zinc-100 shadow-xl ring-1 ring-white/15 backdrop-blur hover:bg-ink-600"
          >
            <ArrowDown className="size-3.5" />
            {paused && pendingCount > 0 ? `Resume · ${pendingCount.toLocaleString()} new lines` : "Jump to latest"}
          </button>
        )}
      </div>

      <footer className="flex items-center gap-3 border-t border-white/[0.06] px-4 py-1.5 text-[11px] text-zinc-500">
        <span className="tabular-nums">{total.toLocaleString()} lines</span>
        {(q || streamFilter !== "all" || hidden.size > 0) && (
          <span className="tabular-nums text-cyan-300/80">{visible.length.toLocaleString()} shown</span>
        )}
        {total >= MAX_LINES && <span>· keeping the latest {MAX_LINES.toLocaleString()}</span>}
        <span className="ml-auto">{follow ? "Following" : "Scrolled"}</span>
      </footer>
    </div>
  );
}

function MetaRow({ line }: { line: Line }) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5">
      <div className="h-px flex-1 bg-white/[0.06]" />
      <span
        className={cx(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
          line.tone === "good" && "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
          line.tone === "bad" && "bg-red-400/10 text-red-300 ring-red-400/20",
          line.tone === "info" && "bg-white/[0.05] text-zinc-400 ring-white/10",
        )}
      >
        {line.tone === "bad" && <TriangleAlert className="size-3" />}
        {line.m}
        <span className="text-zinc-500">{logTime(line.t, false).slice(0, 8)}</span>
      </span>
      <div className="h-px flex-1 bg-white/[0.06]" />
    </div>
  );
}

function ConnBadge({ conn, paused, online }: { conn: Conn; paused: boolean; online: boolean }) {
  if (paused) return <Badge tone="amber">Paused</Badge>;
  if (!online && conn !== "live") return <Badge tone="red">Machine offline</Badge>;
  switch (conn) {
    case "live":
      return (
        <Badge tone="green">
          <span className="size-1.5 animate-pulse-ring rounded-full bg-emerald-400" /> Live
        </Badge>
      );
    case "connecting":
      return <Badge tone="neutral">Connecting…</Badge>;
    case "reconnecting":
      return <Badge tone="amber">Reconnecting…</Badge>;
    case "ended":
      return <Badge tone="neutral">Ended</Badge>;
  }
}
