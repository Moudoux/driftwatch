import { Box, Cpu, HardDrive, Layers, MemoryStick, Plus, Server } from "lucide-react";
import { bytes, relativeTime } from "../lib/format";
import { href } from "../lib/router";
import type { Machine } from "../lib/types";
import { groupContainers } from "./Sidebar";
import { Badge, Button, Card, cx, EmptyState, StatusDot } from "./ui";

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <Card className="relative overflow-hidden px-5 py-4">
      <div className={cx("absolute inset-x-0 top-0 h-px bg-gradient-to-r", accent)} />
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-100">{value}</div>
    </Card>
  );
}

export function Overview({ machines }: { machines: Machine[] }) {
  const online = machines.filter((m) => m.online).length;
  const containers = machines.flatMap((m) => m.containers);
  const running = containers.filter((c) => c.state === "running").length;
  const projects = new Set(machines.flatMap((m) => m.containers.filter((c) => c.project).map((c) => `${m.id}/${c.project}`)));

  return (
    <div className="h-full overflow-y-auto">
      <div className="bg-grid border-b border-white/[0.06] px-8 pb-8 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Overview</h1>
        <p className="mt-1 text-sm text-zinc-500">Pick a container or compose project to stream its logs live.</p>
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Machines online" value={`${online}/${machines.length}`} accent="from-emerald-400/60 to-transparent" />
          <Stat label="Running containers" value={running} accent="from-cyan-400/60 to-transparent" />
          <Stat label="All containers" value={containers.length} accent="from-zinc-400/40 to-transparent" />
          <Stat label="Compose projects" value={projects.size} accent="from-violet-400/60 to-transparent" />
        </div>
      </div>

      <div className="px-8 py-8">
        {machines.length === 0 ? (
          <Card>
            <EmptyState icon={<Server className="size-5" />} title="No machines yet">
              Add an agent on each server you want logs from.
              <div className="mt-4">
                <a href="#/admin/agents">
                  <Button variant="primary" icon={<Plus className="size-4" />}>
                    Add agent
                  </Button>
                </a>
              </div>
            </EmptyState>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {machines.map((m) => (
              <MachineCard key={m.id} m={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MachineCard({ m }: { m: Machine }) {
  const groups = groupContainers(m.containers);
  const running = m.containers.filter((c) => c.state === "running").length;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 px-5 py-4">
        <div className="flex size-10 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08]">
          {m.kind === "local" ? <HardDrive className="size-5 text-zinc-300" /> : <Server className="size-5 text-zinc-300" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold text-zinc-100">{m.name}</h2>
            <StatusDot online={m.online} pulse />
            {m.kind === "local" && <Badge tone="cyan">control</Badge>}
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">
            {m.info ? `${m.info.os} · ${m.info.arch} · Docker ${m.info.dockerVersion}` : (m.address ?? "")}
          </div>
        </div>
        <div className="text-right text-xs text-zinc-500">
          {m.online ? (
            <>
              <div className="tabular-nums text-zinc-300">
                {running}/{m.containers.length} running
              </div>
              {m.latencyMs !== null && <div className="tabular-nums">{m.latencyMs} ms</div>}
            </>
          ) : (
            <div>seen {relativeTime(m.lastSeen)}</div>
          )}
        </div>
      </div>
      {m.info && (
        <div className="flex gap-4 border-t border-white/[0.05] px-5 py-2 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <Cpu className="size-3.5" /> {m.info.cpus} CPUs
          </span>
          <span className="flex items-center gap-1.5">
            <MemoryStick className="size-3.5" /> {bytes(m.info.memTotal)}
          </span>
          <span className="ml-auto font-mono">{m.info.hostname}</span>
        </div>
      )}
      {!m.online && m.error && (
        <div className="border-t border-white/[0.05] bg-red-500/[0.05] px-5 py-2.5 text-xs text-red-300/90">{m.error}</div>
      )}
      {m.online && groups.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-white/[0.05] px-5 py-3">
          {groups.flatMap((g) =>
            g.project
              ? [
                  <a
                    key={g.project}
                    href={href({ name: "project", machine: m.id, project: g.project })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-violet-400/[0.08] px-2 py-1 text-xs text-violet-200 ring-1 ring-inset ring-violet-400/20 transition hover:bg-violet-400/15"
                  >
                    <Layers className="size-3" /> {g.project}
                    <span className="text-violet-300/60">{g.containers.length}</span>
                  </a>,
                ]
              : g.containers.map((c) => (
                  <a
                    key={c.id}
                    href={href({ name: "container", machine: m.id, container: c.name })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1 text-xs text-zinc-300 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.08]"
                  >
                    <Box className="size-3" /> {c.name}
                  </a>
                )),
          )}
        </div>
      )}
    </Card>
  );
}
