import { ChevronRight, LayoutGrid, LogOut, RefreshCw, Search, Settings } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { health, stateColor } from "../lib/format";
import { href, type Route } from "../lib/router";
import type { ContainerInfo, Machine } from "../lib/types";
import { Logo } from "./Logo";
import { cx, IconButton, Input, Kbd, StatusDot } from "./ui";

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
  if (loose.length) groups.push({ project: null, containers: loose.sort((a, b) => a.name.localeCompare(b.name)) });
  return groups;
}

function matches(c: ContainerInfo, q: string) {
  return [c.name, c.image, c.project, c.service].some((v) => v?.toLowerCase().includes(q));
}

function useExpanded(key: string, initial: boolean): [boolean, () => void] {
  const storageKey = `dw:open:${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(storageKey, o ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  return [open, toggle];
}

const rowBase = "flex h-7 items-center gap-2 rounded-md pr-2 text-[13px] transition-colors duration-75";
const rowIdle = "text-fg-muted hover:bg-hover hover:text-fg";
const rowActive = "bg-active text-fg";

function ContainerRow({
  machine,
  c,
  active,
  indent,
}: {
  machine: string;
  c: ContainerInfo;
  active: boolean;
  indent: boolean;
}) {
  const h = health(c.status);
  const stopped = c.state !== "running";
  return (
    <a
      href={href({ name: "container", machine, container: c.name })}
      title={`${c.name}\n${c.image}\n${c.status}`}
      className={cx(rowBase, indent ? "pl-[38px]" : "pl-[24px]", active ? rowActive : rowIdle)}
    >
      <span className={cx("size-1.5 shrink-0 rounded-full", stateColor(c.state))} />
      <span className={cx("truncate", stopped && !active && "text-fg-faint")}>
        {c.project && c.service ? c.service : c.name}
      </span>
      {h === "unhealthy" && <span className="ml-auto text-[11px] text-bad">unhealthy</span>}
      {h === "starting" && <span className="ml-auto text-[11px] text-warn">starting</span>}
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
  const expanded = open || forceOpen;
  return (
    <div>
      <div className={cx(rowBase, "pr-1", active ? rowActive : rowIdle)}>
        <button
          onClick={toggle}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="flex h-full items-center pl-[18px] pr-0.5 text-fg-faint hover:text-fg"
        >
          <ChevronRight className={cx("size-3.5 transition-transform duration-100", expanded && "rotate-90")} />
        </button>
        <a
          href={href({ name: "project", machine, project: group.project })}
          className="flex h-full min-w-0 flex-1 items-center gap-2"
          title="All logs of this compose project"
        >
          <span className="truncate font-medium">{group.project}</span>
          <span className="ml-auto pr-1 text-[11px] tabular-nums text-fg-faint">
            {running}/{group.containers.length}
          </span>
        </a>
      </div>
      {expanded &&
        group.containers.map((c) => (
          <ContainerRow
            key={c.id}
            machine={machine}
            c={c}
            indent
            active={route.name === "container" && route.machine === machine && route.container === c.name}
          />
        ))}
    </div>
  );
}

const MachineNode = memo(function MachineNode({ m, route, query }: { m: Machine; route: Route; query: string }) {
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
    <div className="mb-2">
      <button
        onClick={toggle}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] text-fg transition-colors duration-75 hover:bg-hover"
      >
        <ChevronRight
          className={cx("size-3.5 shrink-0 text-fg-faint transition-transform duration-100", expanded && "rotate-90")}
        />
        <span className="truncate font-medium">{m.name}</span>
        {m.kind === "local" && <span className="text-[11px] text-fg-faint">local</span>}
        <span className="ml-auto flex items-center gap-2">
          {m.online && <span className="text-[11px] tabular-nums text-fg-faint">{running}</span>}
          <StatusDot online={m.online} />
        </span>
      </button>
      {expanded && (
        <div>
          {!m.online && (
            <div className="mb-1 ml-[24px] mr-1 py-1 text-[11px] leading-snug text-bad">
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
              g.containers.map((c) => (
                <ContainerRow
                  key={c.id}
                  machine={m.id}
                  c={c}
                  indent={false}
                  active={route.name === "container" && route.machine === m.id && route.container === c.name}
                />
              ))
            ),
          )}
          {m.online && m.containers.length === 0 && (
            <div className="ml-[24px] py-1 text-xs text-fg-faint">No containers</div>
          )}
        </div>
      )}
    </div>
  );
});

function NavLink({ to, active, icon, children }: { to: string; active: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <a href={to} className={cx(rowBase, "h-8 px-2 font-medium", active ? rowActive : rowIdle)}>
      {icon}
      {children}
    </a>
  );
}

export const Sidebar = memo(function Sidebar({
  machines,
  route,
  loaded,
  refreshing,
  onRefresh,
  onLogout,
}: {
  machines: Machine[];
  route: Route;
  loaded: boolean;
  refreshing: boolean;
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
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-12 items-center justify-between pl-4 pr-2">
        <a href="#/">
          <Logo />
        </a>
        <IconButton label="Refresh now" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cx("size-3.5", refreshing && "animate-spin")} />
        </IconButton>
      </div>

      <div className="px-2 pb-2">
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Find container"
          icon={<Search className="size-3.5" />}
          trailing={<Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>}
        />
      </div>

      <nav className="px-2 pb-3">
        <NavLink to="#/" active={route.name === "overview"} icon={<LayoutGrid className="size-4 text-fg-faint" />}>
          Overview
        </NavLink>
      </nav>

      <div className="flex items-center justify-between px-4 pb-1 text-[11px] font-medium text-fg-faint">
        Machines
        <span className="tabular-nums">{machines.length || ""}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {machines.map((m) => (
          <MachineNode key={m.id} m={m} route={route} query={q} />
        ))}
        {machines.length === 0 && loaded && (
          <div className="px-2 py-3 text-xs leading-relaxed text-fg-faint">
            No machines yet.{" "}
            <a href="#/admin/agents" className="text-accent hover:underline">
              Add an agent
            </a>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-line p-2">
        <div className="flex-1">
          <NavLink
            to="#/admin/agents"
            active={route.name === "admin"}
            icon={<Settings className="size-4 text-fg-faint" />}
          >
            Settings
          </NavLink>
        </div>
        <IconButton label="Sign out" onClick={onLogout}>
          <LogOut className="size-3.5" />
        </IconButton>
      </div>
    </aside>
  );
});
