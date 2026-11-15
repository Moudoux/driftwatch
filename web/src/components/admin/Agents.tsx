import { Pencil, Plus, RotateCcw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDate, relativeTime } from "../../lib/format";
import type { AgentRow, AgentSnippet, MachineStatus } from "../../lib/types";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, IconButton, Input, Modal, Spinner, StatusDot } from "../ui";
import { SnippetDialog } from "./SnippetDialog";

type Entry = { agent: AgentRow; status: MachineStatus };

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

export function Agents({ onChanged }: { onChanged: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState<AgentRow | null>(null);
  const [snippet, setSnippet] = useState<{ agent: AgentRow; snippet: AgentSnippet; reissued?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .agents()
      .then(setEntries)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const reissue = async (a: AgentRow) => {
    if (!confirm(`Issue a new certificate for ${a.name}? The current one stops working until you update the agent.`))
      return;
    setBusy(a.id);
    try {
      const res = await api.reissueAgent(a.id);
      setSnippet({ ...res, reissued: true });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Agents</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Each agent runs next to Docker on a machine. The control server connects to it over Tailscale with mutual
            TLS.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          Add agent
        </Button>
      </div>
      <ErrorNote error={error} />

      <Card className="overflow-hidden">
        {entries === null ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={<Server className="size-5" />} title="No agents yet">
            Add one for every machine you want to see logs from.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {entries.map(({ agent: a, status: s }) => (
              <li key={a.id} className="flex items-center gap-4 px-5 py-4">
                <StatusDot online={s.online} pulse />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-100">{a.name}</span>
                    <span className="font-mono text-xs text-zinc-500">{a.id}</span>
                    {s.info && <Badge>v{s.info.version}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    <span className="font-mono">
                      {a.address}:{a.port}
                    </span>
                    {" · "}
                    {s.online
                      ? `${s.containers.length} containers · ${s.latencyMs ?? "?"} ms`
                      : s.error
                        ? s.error
                        : `last seen ${relativeTime(s.lastSeen)}`}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-600">
                    Certificate issued {formatDate(a.certIssuedAt)} · sha256 {a.fingerprint.slice(0, 16)}…
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton label="Edit" onClick={() => setEditing(a)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton label="Reissue certificate" onClick={() => reissue(a)} disabled={busy === a.id}>
                    <RotateCcw className="size-4" />
                  </IconButton>
                  <IconButton label="Remove" onClick={() => setDeleting(a)} className="hover:!text-red-300">
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AgentForm
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(res) => {
          setAdding(false);
          if (res) setSnippet(res);
          load();
          onChanged();
        }}
      />
      {editing && (
        <AgentForm
          open
          agent={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            onChanged();
          }}
        />
      )}
      {snippet && (
        <SnippetDialog
          open
          onClose={() => setSnippet(null)}
          agent={snippet.agent}
          snippet={snippet.snippet}
          reissued={snippet.reissued}
        />
      )}
      {deleting && (
        <Modal open onClose={() => setDeleting(null)} title={`Remove ${deleting.name}?`}>
          <p className="text-sm text-zinc-400">
            The control server stops connecting to this agent and forgets its certificate. Remember to remove the
            containers from the machine too.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-4" />}
              onClick={async () => {
                try {
                  await api.deleteAgent(deleting.id);
                } catch (e) {
                  setError((e as Error).message);
                }
                setDeleting(null);
                load();
                onChanged();
              }}
            >
              Remove agent
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AgentForm({
  open,
  onClose,
  onSaved,
  agent,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (res?: { agent: AgentRow; snippet: AgentSnippet }) => void;
  agent?: AgentRow;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [address, setAddress] = useState(agent?.address ?? "");
  const [port, setPort] = useState(String(agent?.port ?? 7443));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !agent) {
      setName("");
      setAddress("");
      setPort("7443");
      setError(null);
    }
  }, [open, agent]);

  const defaultAddress = `driftwatch-${slug(name)}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, address: address.trim() || undefined, port: Number(port) || 7443 };
      if (agent) {
        await api.updateAgent(agent.id, body);
        onSaved();
      } else {
        onSaved(await api.createAgent(body));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : "Add an agent"}
      description={agent ? undefined : "You'll get a compose snippet with a fresh certificate for this machine."}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. NAS" autoFocus required maxLength={64} />
        </Field>
        <Field
          label="Tailscale host name or IP"
          hint={
            <>
              How the control server reaches the agent. Short MagicDNS names are expanded with your tailnet domain.
              {!agent && (
                <>
                  {" "}
                  Defaults to <code className="text-zinc-400">{defaultAddress}</code>.
                </>
              )}
            </>
          }
        >
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={agent ? "" : defaultAddress} />
        </Field>
        <Field label="Port">
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {agent ? "Save" : "Create agent"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
