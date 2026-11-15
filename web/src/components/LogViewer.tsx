import { ArrowDown, Clock, Download, Eraser, Pause, Play, Search, WrapText } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseAnsi, stripAnsi } from "../lib/ansi";
import { logsUrl } from "../lib/api";
import { isoTime, logTime, stateColor, tagColor } from "../lib/format";
import { href } from "../lib/router";
import { useAppendVirtualizer } from "../lib/virtual";
import type { ContainerInfo, LogEvent } from "../lib/types";
import { cx, IconButton, Input, Kbd, Segmented, Select } from "./ui";

const MAX_LINES = 50_000;
/** Trim in chunks so the buffer isn't spliced on every batch once full. */
const TRIM_SLACK = 5_000;
const TAILS = [100, 500, 1000, 5000, 20000];
/** New lines are applied in batches at most this often. */
const FLUSH_MS = 50;
const ROW_H = 20;
const META_H = 32;
const CHAR_W = 7.2; // 12px JetBrains Mono

interface Line {
  seq: number;
  /** Container id, or "" for stream-wide notices. */
  c: string;
  /** stdout, stderr, or a meta notice. */
  s: "o" | "e" | "m";
  t: number;
  m: string;
  /** Lower-cased plain text, computed lazily for filtering. */
  p?: string;
  tone?: "good" | "bad" | "info";
}

const plainOf = (l: Line) => (l.p ??= stripAnsi(l.m).toLowerCase());

type Conn = "connecting" | "live" | "reconnecting" | "ended";
type StreamFilter = "all" | "o" | "e";

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
      return { text: `Lost connection to agent${msg ? `: ${msg}` : ""}, retrying`, tone: "bad" };
    case "error":
      return { text: `Error${msg ? `: ${msg}` : ""}`, tone: "bad" };
    default:
      return null;
  }
}

function Highlight({ text, q }: { text: string; q: string }) {
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

function Message({ m, q }: { m: string; q: string }) {
  if (q) return <Highlight text={stripAnsi(m)} q={q} />;
  if (!m.includes("\x1b")) return <>{m}</>;
  return (
    <>
      {parseAnsi(m).map((seg, i) =>
        seg.fg || seg.bg || seg.bold || seg.dim || seg.italic || seg.underline ? (
          <span
            key={i}
            style={{
              color: seg.fg,
              backgroundColor: seg.bg,
              fontWeight: seg.bold ? 600 : undefined,
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
}

interface RowProps {
  line: Line;
  q: string;
  wrap: boolean;
  showTs: boolean;
  showDate: boolean;
  name?: string;
  nameWidth: number;
}

/** Memoised so a render only builds rows that are new or changed. */
const Row = memo(function Row({ line: l, q, wrap, showTs, showDate, name, nameWidth }: RowProps) {
  if (l.s === "m") {
    return (
      <div
        className={cx(
          "flex h-8 items-center gap-3 px-4 text-[11px] font-medium",
          l.tone === "good" ? "text-ok" : l.tone === "bad" ? "text-bad" : "text-fg-faint",
        )}
      >
        <div className="h-px flex-1 bg-line" />
        <span className="max-w-[80%] truncate">{l.m}</span>
        <span className="font-mono font-normal tabular-nums text-fg-faint">{logTime(l.t, false).slice(0, 8)}</span>
        <div className="h-px flex-1 bg-line" />
      </div>
    );
  }
  return (
    <div
      className={cx(
        "log-row flex gap-3 border-l-2 pl-[14px] pr-4 hover:bg-hover",
        l.s === "e" ? "border-bad/60 bg-[var(--stderr)]" : "border-transparent",
      )}
    >
      {showTs && <span className="shrink-0 select-none tabular-nums text-fg-faint">{logTime(l.t, showDate)}</span>}
      {name !== undefined && (
        <span
          className="shrink-0 select-none truncate"
          style={{ color: tagColor(name), width: `${nameWidth}ch` }}
        >
          {name}
        </span>
      )}
      <span className={cx("min-w-0", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
        <Message m={l.m} q={q} />
      </span>
    </div>
  );
});

export const LogViewer = memo(function LogViewer({
  machineId,
  machineName,
  online,
  containers,
  title,
  project,
  isProject,
}: {
  machineId: string;
  machineName: string;
  online: boolean;
  containers: ContainerInfo[];
  title: string;
  project?: string;
  isProject: boolean;
}) {
  const ids = useMemo(() => containers.map((c) => c.id).sort(), [containers]);
  const idsKey = ids.join(",");
  const multi = ids.length > 1;
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of containers) m.set(c.id, c.project && c.service ? c.service : c.name);
    return m;
  }, [containers]);
  const namesRef = useRef(names);
  namesRef.current = names;
  const nameWidth = useMemo(() => Math.min(22, Math.max(6, ...[...names.values()].map((n) => n.length))), [names]);

  const [tail, setTail] = useStored("dw:tail", 500);
  const [wrap, setWrap] = useStored("dw:wrap", true);
  const [showTs, setShowTs] = useStored("dw:ts", true);
  const [filter, setFilter] = useState("");
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [paused, setPaused] = useState(false);
  const [conn, setConn] = useState<Conn>("connecting");
  const [version, setVersion] = useState(0);
  const [follow, setFollow] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [width, setWidth] = useState(0);

  const linesRef = useRef<Line[]>([]);
  const pendingRef = useRef<Line[]>([]);
  const pausedRef = useRef(paused);
  const seqRef = useRef(0);
  const lastTRef = useRef<number | undefined>(undefined);
  const statesRef = useRef(new Map<string, string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  /** Set when lines were reordered or trimmed, so the filtered view is rebuilt. */
  const dirtyRef = useRef(true);
  /** Bumped whenever rows are removed or reordered, for the virtualizer. */
  const epochRef = useRef(0);

  const flush = useCallback(() => {
    timerRef.current = null;
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
    if (outOfOrder) {
      lines.sort((a, b) => a.t - b.t || a.seq - b.seq);
      dirtyRef.current = true;
      epochRef.current++;
    }
    if (lines.length > MAX_LINES + TRIM_SLACK) {
      lines.splice(0, lines.length - MAX_LINES);
      dirtyRef.current = true;
      epochRef.current++;
    }
    setPendingCount(0);
    setVersion((v) => v + 1);
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current === null) timerRef.current = setTimeout(flush, FLUSH_MS);
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
    dirtyRef.current = true;
    setVersion((v) => v + 1);
    setConn("connecting");
    setFollow(true);
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const isMulti = idsKey.includes(",");

    const meta = (text: string, tone: Line["tone"], c = "") => {
      const t = lastTRef.current ?? Date.now() * 1000;
      pendingRef.current.push({ seq: seqRef.current++, c, s: "m", t, m: text, tone });
    };

    const ingest = (events: LogEvent[]) => {
      const pending = pendingRef.current;
      for (const ev of events) {
        if (ev.k === "l") {
          if (lastTRef.current === undefined || ev.t > lastTRef.current) lastTRef.current = ev.t;
          pending.push({ seq: seqRef.current++, c: ev.c, s: ev.s, t: ev.t, m: ev.m });
        } else {
          const prev = statesRef.current.get(ev.c);
          statesRef.current.set(ev.c, ev.state);
          // The first state per container is just its current state.
          if (prev === undefined && ev.c !== "*") continue;
          if (prev === ev.state) continue;
          const d = describeState(ev.state, ev.msg);
          if (d) {
            const who = namesRef.current.get(ev.c) ?? ev.c;
            meta(isMulti && ev.c !== "*" ? `${who}: ${d.text}` : d.text, d.tone, ev.c === "*" ? "" : ev.c);
          }
        }
      }
      if (pending.length > MAX_LINES) pending.splice(0, pending.length - MAX_LINES);
      schedule();
    };

    const open = (since?: number) => {
      es = new EventSource(logsUrl(machineId, idsKey.split(","), tail, since));
      es.onopen = () => setConn("live");
      es.addEventListener("logs", (e) => ingest(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("end", () => {
        es?.close();
        setConn("ended");
        meta("Stream ended: the container no longer exists", "info");
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
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [machineId, idsKey, tail, schedule]);

  // Filtered view, maintained incrementally: only lines added since the last
  // render are tested unless the filter changed or the buffer was reordered.
  const q = filter.trim().toLowerCase();
  const filtering = q !== "" || streamFilter !== "all" || hidden.size > 0;
  const viewRef = useRef<{ key: string; done: number; out: Line[] }>({ key: "", done: 0, out: [] });
  const filterKey = `${q}\0${streamFilter}\0${[...hidden].join(",")}`;
  const visible = useMemo(() => {
    const lines = linesRef.current;
    if (!filtering) {
      dirtyRef.current = false;
      viewRef.current = { key: "", done: 0, out: [] };
      return lines;
    }
    const keep = (l: Line) =>
      (l.s === "m" || streamFilter === "all" || l.s === streamFilter) &&
      (!l.c || !hidden.has(l.c)) &&
      (!q || plainOf(l).includes(q));
    let v = viewRef.current;
    if (v.key !== filterKey || dirtyRef.current || v.done > lines.length) {
      v = { key: filterKey, done: 0, out: [] };
      dirtyRef.current = false;
    }
    const out = v.out;
    for (let i = v.done; i < lines.length; i++) if (keep(lines[i])) out.push(lines[i]);
    v.done = lines.length;
    viewRef.current = v;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filterKey, filtering]);
  const count = visible.length;
  const lastVisible = useRef(visible);
  if (lastVisible.current !== visible) {
    lastVisible.current = visible;
    epochRef.current++;
  }

  // Track the viewport width, for wrapped-row height estimates.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showDate = useMemo(() => {
    const lines = linesRef.current;
    if (!lines.length) return false;
    return new Date(lines[0].t / 1000).toDateString() !== new Date().toDateString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const prefixCh = (showTs ? (showDate ? 23 : 12) + 2 : 0) + (multi ? nameWidth + 2 : 0);
  const cols = Math.max(20, Math.floor((width - 36) / CHAR_W) - prefixCh);

  const layoutKey = wrap ? `wrap:${width}:${showTs}:${showDate}:${nameWidth}:${multi}` : "nowrap";
  const { start, end, total: totalSize, offsetOf, rowsRef } = useAppendVirtualizer({
    scrollRef,
    count,
    estimate: (i) => {
      const l = visible[i];
      if (l.s === "m") return META_H;
      if (!wrap) return ROW_H;
      return Math.max(1, Math.ceil(l.m.length / cols)) * ROW_H;
    },
    keyOf: (i) => visible[i].seq,
    measure: wrap,
    layoutKey,
    epoch: epochRef.current,
    follow,
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom) {
      if (!follow) setFollow(true);
    } else if (el.scrollTop < lastScrollTop.current - 2 && follow) setFollow(false);
    lastScrollTop.current = el.scrollTop;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        filterRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    dirtyRef.current = true;
    setVersion((v) => v + 1);
  };

  const toggleHidden = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const single = !multi ? containers[0] : undefined;
  const total = linesRef.current.length;
  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const l = visible[i];
    rows.push(
      <div
        key={l.seq}
        data-i={i}
        className="absolute left-0 top-0 w-full"
        style={{ transform: `translateY(${offsetOf(i)}px)`, height: wrap ? undefined : l.s === "m" ? META_H : ROW_H }}
      >
        <Row
          line={l}
          q={q}
          wrap={wrap}
          showTs={showTs}
          showDate={showDate}
          name={multi && l.c ? (names.get(l.c) ?? l.c.slice(0, 12)) : undefined}
          nameWidth={nameWidth}
        />
      </div>,
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line">
        <div className="flex items-center gap-3 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-fg-faint">
              <span className="truncate">{machineName}</span>
              {project && !isProject && (
                <>
                  <span>/</span>
                  <a href={href({ name: "project", machine: machineId, project })} className="truncate hover:text-fg">
                    {project}
                  </a>
                </>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              {single && <span className={cx("size-1.5 shrink-0 rounded-full", stateColor(single.state))} />}
              <h1 className="truncate text-[15px] font-semibold text-fg">{title}</h1>
              {single && <span className="hidden truncate font-mono text-xs text-fg-faint md:inline">{single.image}</span>}
              {multi && <span className="text-xs text-fg-faint">{containers.length} containers</span>}
            </div>
          </div>
          <ConnStatus conn={conn} paused={paused} online={online} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
          <Input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder="Filter"
            icon={<Search className="size-3.5" />}
            trailing={<Kbd>/</Kbd>}
            className="w-full min-w-40 max-w-64 flex-1 [&_input]:h-7"
          />
          <Segmented
            value={streamFilter}
            onChange={setStreamFilter}
            items={[
              { value: "all", label: "All" },
              { value: "o", label: "stdout" },
              { value: "e", label: "stderr" },
            ]}
          />
          <div className="mx-1 h-4 w-px bg-line" />
          <IconButton label="Timestamps" active={showTs} onClick={() => setShowTs(!showTs)}>
            <Clock className="size-3.5" />
          </IconButton>
          <IconButton label="Wrap lines" active={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText className="size-3.5" />
          </IconButton>
          <IconButton label={paused ? "Resume" : "Pause"} active={paused} onClick={() => setPaused(!paused)}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </IconButton>
          <IconButton label="Clear" onClick={clear}>
            <Eraser className="size-3.5" />
          </IconButton>
          <IconButton label="Download shown lines" onClick={download} disabled={!count}>
            <Download className="size-3.5" />
          </IconButton>
          <label className="ml-auto flex items-center gap-2 text-xs text-fg-faint">
            History
            <Select value={tail} onChange={(e) => setTail(Number(e.target.value))} className="w-auto">
              {TAILS.map((t) => (
                <option key={t} value={t}>
                  {t.toLocaleString()} lines
                </option>
              ))}
            </Select>
          </label>
        </div>

        {multi && (
          <div className="flex flex-wrap gap-1 px-3 pb-2.5">
            {containers.map((c) => {
              const off = hidden.has(c.id);
              const name = names.get(c.id) ?? c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => toggleHidden(c.id)}
                  aria-pressed={!off}
                  title={off ? "Show this container" : "Hide this container"}
                  className={cx(
                    "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors duration-75",
                    off ? "border-line text-fg-faint line-through" : "border-line-strong text-fg hover:bg-hover",
                  )}
                >
                  <span className="size-1.5 rounded-full" style={{ background: off ? "var(--line-strong)" : tagColor(name) }} />
                  {name}
                  {c.state !== "running" && <span className="text-fg-faint">{c.state}</span>}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="absolute inset-0 overflow-auto py-1.5 font-mono text-[12px] leading-5 text-fg"
          style={{ contain: "strict" }}
        >
          {count === 0 ? (
            <div className="flex h-full items-center justify-center font-sans text-[13px] text-fg-faint">
              {conn === "connecting" ? "Connecting…" : filtering ? "No lines match" : "Waiting for log output…"}
            </div>
          ) : (
            <div
              ref={rowsRef}
              style={{ height: totalSize, position: "relative", minWidth: wrap ? undefined : "max-content" }}
            >
              {rows}
            </div>
          )}
        </div>

        {(!follow || (paused && pendingCount > 0)) && count > 0 && (
          <button
            onClick={() => {
              setPaused(false);
              setFollow(true);
            }}
            className="absolute bottom-4 left-1/2 inline-flex h-8 -translate-x-1/2 animate-rise items-center gap-1.5 rounded-full bg-fg px-3.5 text-xs font-medium text-canvas shadow-md hover:opacity-90"
          >
            <ArrowDown className="size-3.5" />
            {paused && pendingCount > 0 ? `Resume · ${pendingCount.toLocaleString()} new` : "Jump to latest"}
          </button>
        )}
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line px-4 text-[11px] tabular-nums text-fg-faint">
        <span>{total.toLocaleString()} lines</span>
        {filtering && <span className="text-fg-muted">{count.toLocaleString()} shown</span>}
        {total >= MAX_LINES && <span>keeping the latest {MAX_LINES.toLocaleString()}</span>}
        <span className="ml-auto">{follow ? "Following" : "Scrolled up"}</span>
      </footer>
    </div>
  );
});

function ConnStatus({ conn, paused, online }: { conn: Conn; paused: boolean; online: boolean }) {
  let dot = "bg-fg-faint";
  let text = "Connecting";
  if (paused) {
    dot = "bg-warn";
    text = "Paused";
  } else if (!online && conn !== "live") {
    dot = "bg-bad";
    text = "Machine offline";
  } else if (conn === "live") {
    dot = "bg-ok";
    text = "Live";
  } else if (conn === "reconnecting") {
    dot = "bg-warn";
    text = "Reconnecting";
  } else if (conn === "ended") {
    text = "Ended";
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
      <span className={cx("size-1.5 rounded-full", dot)} />
      {text}
    </span>
  );
}
