import { Plus, Server } from "lucide-react";
import { bytes, relativeTime, stateColor } from "../lib/format";
import { href } from "../lib/router";
import type { Machine } from "../lib/types";
import { groupContainers } from "./Sidebar";
import { Button, Card, cx, EmptyState, PageHeader, Spinner, StatusDot } from "./ui";

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-5 py-4 first:pl-0 sm:px-6">
      <div className="text-xs text-fg-faint">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-fg">{value}</div>
    </div>
  );
}

export function Overview({ machines, loaded }: { machines: Machine[]; loaded: boolean }) {
  const online = machines.filter((m) => m.online).length;
  const containers = machines.flatMap((m) => m.containers);
  const running = containers.filter((c) => c.state === "running").length;
  const projects = new Set(
    machines.flatMap((m) => m.containers.filter((c) => c.project).map((c) => `${m.id}/${c.project}`)),
  );

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Overview" description="Pick a container or compose project to stream its logs.">
        <div className="-mb-px grid grid-cols-2 divide-line sm:flex sm:divide-x">
          <Stat label="Machines online" value={`${online}/${machines.length}`} />
          <Stat label="Running" value={running} />
          <Stat label="Containers" value={containers.length} />
          <Stat label="Compose projects" value={projects.size} />
        </div>
      </PageHeader>

      <div className="px-5 py-6 sm:px-8">
        {!loaded ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : machines.length === 0 ? (
          <Card>
            <EmptyState icon={<Server className="size-5" />} title="No machines yet">
              Add an agent on each server you want logs from.
              <div className="mt-4">
                <a href="#/admin/agents">
                  <Button variant="primary" icon={<Plus className="size-3.5" />}>
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
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot online={m.online} />
            <h2 className="truncate text-sm font-semibold text-fg">{m.name}</h2>
            {m.kind === "local" && <span className="text-xs text-fg-faint">local</span>}
          </div>
          <div className="mt-0.5 truncate pl-3.5 text-xs text-fg-faint">
            {m.info
              ? `${m.info.hostname} · ${m.info.os}/${m.info.arch} · Docker ${m.info.dockerVersion} · ${m.info.cpus} CPU · ${bytes(m.info.memTotal)}`
              : (m.address ?? "")}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs tabular-nums text-fg-faint">
          {m.online ? (
            <>
              <div className="text-fg-muted">
                {running}/{m.containers.length} running
              </div>
              {m.latencyMs !== null && <div>{m.latencyMs} ms</div>}
            </>
          ) : (
            <div>seen {relativeTime(m.lastSeen)}</div>
          )}
        </div>
      </div>
      {!m.online && m.error && <div className="border-t border-line px-4 py-2.5 text-xs text-bad">{m.error}</div>}
      {m.online && groups.length > 0 && (
        <div className="border-t border-line">
          {groups.map((g) =>
            g.project ? (
              <a
                key={g.project}
                href={href({ name: "project", machine: m.id, project: g.project })}
                className="flex h-9 items-center gap-3 border-b border-line px-4 text-[13px] transition-colors duration-75 last:border-b-0 hover:bg-hover"
              >
                <span className="truncate font-medium text-fg">{g.project}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {g.containers.map((c) => (
                    <span
                      key={c.id}
                      title={`${c.service ?? c.name}: ${c.state}`}
                      className={cx("size-1.5 shrink-0 rounded-full", stateColor(c.state))}
                    />
                  ))}
                </span>
                <span className="text-xs tabular-nums text-fg-faint">
                  {g.containers.filter((c) => c.state === "running").length}/{g.containers.length}
                </span>
              </a>
            ) : (
              <div key="loose" className="flex flex-wrap gap-1 px-4 py-2.5">
                {g.containers.map((c) => (
                  <a
                    key={c.id}
                    href={href({ name: "container", machine: m.id, container: c.name })}
                    className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-fg-muted transition-colors duration-75 hover:bg-hover hover:text-fg"
                  >
                    <span className={cx("size-1.5 rounded-full", stateColor(c.state))} />
                    {c.name}
                  </a>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}
