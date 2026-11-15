import {
  Box,
  ChevronRight,
  HardDrive,
  Layers,
  LayoutGrid,
  LogOut,
  RefreshCw,
  Search,
  Server,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { health, stateColor } from "../lib/format";
import { href, type Route } from "../lib/router";
import type { ContainerInfo, Machine } from "../lib/types";
import { Logo } from "./Logo";
import { cx, IconButton, Kbd, StatusDot } from "./ui";

export interface Group {
  project: string | null;
  containers: ContainerInfo[];
}

export function groupContainers(containers: ContainerInfo[]): Group[] {
  const projects = new Map<string, ContainerInfo[]>();
  const loose: ContainerInfo[] = [];
  for (const c of containers) {
    if (c.project) {
      if (!projects.has(c.project)) projects.set(c.project, []);
      projects.get(c.project)!.push(c);
    } else loose.push(c);
  }
  const groups: Group[] = [...projects.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, cs]) => ({
      project,
      containers: cs.sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name)),
    }));
  if (loose.length) groups.push({ project: null, containers: loose });
  return groups;
}

function matches(c: ContainerInfo, q: string) {
  return [c.name, c.image, c.project, c.service].some((v) => v?.toLowerCase().includes(q));
}

function useExpanded(key: string, initial: boolean): [boolean, () => void] {
  const storageKey = `dw:open:${key}`;
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(storageKey);
    return v === null ? initial : v === "1";
  });
  const toggle = () =>
    setOpen((o) => {
      localStorage.setItem(storageKey, o ? "0" : "1");
      return !o;
    });
  return [open, toggle];
}

function ContainerRow({
  machine,
  c,
  route,
  indent,
}: {
  machine: string;
  c: ContainerInfo;
  route: Route;
  indent: boolean;
}) {
  const active = route.name === "container" && route.machine === machine && route.container === c.name;
  const h = health(c.status);
  return (
    <a
      href={href({ name: "container", machine, container: c.name })}
      title={`${c.name}\n${c.image}\n${c.status}`}
      className={cx(
        "group flex h-7 items-center gap-2 rounded-md pr-2 text-[13px] transition-colors",
        indent ? "pl-[42px]" : "pl-[26px]",
        active ? "bg-cyan-400/10 text-cyan-100" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200",
      )}
    >
      <span className={cx("size-1.5 shrink-0 rounded-full", stateColor(c.state))} />
      <span className={cx("truncate", c.state !== "running" && "text-zinc-500")}>
        {c.project && c.service ? c.service : c.name}
      </span>
      {h === "unhealthy" && <span className="ml-auto text-[10px] font-medium text-red-400">unhealthy</span>}
      {h === "starting" && <span className="ml-auto text-[10px] font-medium text-amber-400">starting</span>}
    </a>
  );
}

function ProjectGroup({
  machine,
  group,
  route,
  forceOpen,
}: {
  machine: string;
  group: Group & { project: string };
  route: Route;
  forceOpen: boolean;
}) {
  const [open, toggle] = useExpanded(`${machine}/${group.project}`, true);
  const active = route.name === "project" && route.machine === machine && route.project === group.project;
  const running = group.containers.filter((c) => c.state === "running").length;
  return (
    <div>
      <div
        className={cx(
          "group flex h-7 items-center rounded-md pr-1 text-[13px] transition-colors",
          active ? "bg-violet-400/10 text-violet-100" : "text-zinc-300 hover:bg-white/[0.05]",
        )}
      >
        <button onClick={toggle} className="flex h-full items-center pl-[22px] pr-1 text-zinc-500 hover:text-zinc-300">
          <ChevronRight className={cx("size-3.5 transition-transform", (open || forceOpen) && "rotate-90")} />
        </button>
        <a
          href={href({ name: "project", machine, project: group.project })}
          className="flex min-w-0 flex-1 items-center gap-2"
          title="View all logs of this compose project"
        >
          <Layers className="size-3.5 shrink-0 text-violet-300/80" />
          <span className="truncate font-medium">{group.project}</span>
          <span className="ml-auto pr-1 text-[11px] tabular-nums text-zinc-500">
            {running}/{group.containers.length}
          </span>
        </a>
      </div>
      {(open || forceOpen) &&
        group.containers.map((c) => <ContainerRow key={c.id} machine={machine} c={c} route={route} indent />)}
    </div>
  );
}

function MachineNode({ m, route, query }: { m: Machine; route: Route; query: string }) {
  const [open, toggle] = useExpanded(m.id, true);
  const containers = useMemo(
    () => (query ? m.containers.filter((c) => matches(c, query)) : m.containers),
    [m.containers, query],
  );
  const groups = useMemo(() => groupContainers(containers), [containers]);
  if (query && containers.length === 0) return null;
  const running = m.containers.filter((c) => c.state === "running").length;
  const expanded = open || !!query;
  return (
    <div className="mb-1">
      <button
        onClick={toggle}
        className="group flex h-8 w-full items-center gap-2 rounded-lg px-1.5 text-left text-[13px] text-zinc-200 transition-colors hover:bg-white/[0.05]"
      >
        <ChevronRight
          className={cx("size-3.5 shrink-0 text-zinc-500 transition-transform", expanded && "rotate-90")}
        />
        {m.kind === "local" ? (
          <HardDrive className="size-4 shrink-0 text-zinc-400" />
        ) : (
          <Server className="size-4 shrink-0 text-zinc-400" />
        )}
        <span className="truncate font-semibold">{m.name}</span>
        <span className="ml-auto flex items-center gap-2">
          {m.online && <span className="text-[11px] tabular-nums text-zinc-500">{running}</span>}
          <StatusDot online={m.online} />
        </span>
      </button>
      {expanded && (
        <div className="mt-0.5">
          {!m.online && (
            <div className="ml-[26px] mr-2 mb-1 rounded-md bg-red-500/[0.07] px-2 py-1.5 text-[11px] leading-snug text-red-300/90 ring-1 ring-inset ring-red-500/15">
              {m.error ?? "Not reachable yet"}
            </div>
          )}
          {groups.map((g) =>
            g.project ? (
              <ProjectGroup
                key={g.project}
                machine={m.id}
                group={g as Group & { project: string }}
                route={route}
                forceOpen={!!query}
              />
            ) : (
              g.containers.map((c) => <ContainerRow key={c.id} machine={m.id} c={c} route={route} indent={false} />)
            ),
          )}
          {m.online && m.containers.length === 0 && (
            <div className="ml-[26px] py-1 text-xs text-zinc-600">No containers</div>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  machines,
  route,
  loading,
  onRefresh,
  onLogout,
}: {
  machines: Machine[];
  route: Route;
  loading: boolean;
  onRefresh: () => void;
  onLogout: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const q = query.trim().toLowerCase();

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-white/[0.06] bg-ink-850/80">
      <div className="flex h-14 items-center justify-between px-4">
        <a href="#/">
          <Logo />
        </a>
        <IconButton label="Refresh" onClick={onRefresh}>
          <RefreshCw className={cx("size-4", loading && "animate-spin")} />
        </IconButton>
      </div>
      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Filter containers"
            className="h-8 w-full rounded-lg bg-white/[0.04] pl-8 pr-12 text-[13px] text-zinc-100 ring-1 ring-inset ring-white/[0.08] placeholder:text-zinc-500 focus:outline-none focus:ring-cyan-400/40"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
            <Kbd>Ctrl K</Kbd>
          </span>
        </div>
      </div>

      <nav className="px-3">
        <a
          href="#/"
          className={cx(
            "flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium transition-colors",
            route.name === "overview" ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200",
          )}
        >
          <LayoutGrid className="size-4" /> Overview
        </a>
      </nav>

      <div className="mt-4 flex items-center justify-between px-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Machines
        <span className="tabular-nums">{machines.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {machines.map((m) => (
          <MachineNode key={m.id} m={m} route={route} query={q} />
        ))}
        {machines.length === 0 && !loading && (
          <div className="mx-2 mt-2 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-zinc-500">
            <Box className="mx-auto mb-2 size-5 text-zinc-600" />
            No machines yet.{" "}
            <a href="#/admin/agents" className="text-cyan-300 hover:underline">
              Add an agent
            </a>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-white/[0.06] p-2">
        <a
          href="#/admin/agents"
          className={cx(
            "flex h-9 flex-1 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors",
            route.name === "admin" ? "bg-white/[0.07] text-zinc-100" : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200",
          )}
        >
          <Settings className="size-4" /> Admin
        </a>
        <IconButton label="Sign out" onClick={onLogout}>
          <LogOut className="size-4" />
        </IconButton>
      </div>
    </aside>
  );
}
