import { Pencil, Plus, RotateCcw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDate, relativeTime } from "../../lib/format";
import type { AgentRow, AgentSnippet, MachineStatus } from "../../lib/types";
import {
  Button,
  Card,
  Code,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  Modal,
  ModalActions,
  SectionHeader,
  Spinner,
  StatusDot,
} from "../ui";
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
  const [reissuing, setReissuing] = useState<AgentRow | null>(null);
  const [snippet, setSnippet] = useState<{ agent: AgentRow; snippet: AgentSnippet; reissued?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .agents()
      .then(setEntries)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const reissue = async (a: AgentRow) => {
    setBusy(true);
    try {
      const res = await api.reissueAgent(a.id);
      setReissuing(null);
      setSnippet({ ...res, reissued: true });
      load();
    } catch (e) {
      setError((e as Error).message);
      setReissuing(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AgentRow) => {
    setBusy(true);
    try {
      await api.deleteAgent(a.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
    setDeleting(null);
    load();
    onChanged();
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Agents"
        description="Each agent runs next to Docker on a machine. The control server connects to it over Tailscale with mutual TLS."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add agent
          </Button>
        }
      />
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
          <ul className="divide-y divide-line">
            {entries.map(({ agent: a, status: s }) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <StatusDot online={s.online} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13px] font-medium text-fg">{a.name}</span>
                    <span className="font-mono text-xs text-fg-faint">{a.id}</span>
                    {s.info && <span className="text-xs text-fg-faint">v{s.info.version}</span>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-fg-muted">
                    <span className="font-mono">
                      {a.address}:{a.port}
                    </span>
                    {" · "}
                    {s.online ? (
                      `${s.containers.length} containers · ${s.latencyMs ?? "?"} ms`
                    ) : s.error ? (
                      <span className="text-bad">{s.error}</span>
                    ) : (
                      `last seen ${relativeTime(s.lastSeen)}`
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-fg-faint">
                    Certificate issued {formatDate(a.certIssuedAt)} · sha256 {a.fingerprint.slice(0, 16)}…
                  </div>
                </div>
                <div className="flex shrink-0 items-center">
                  <IconButton label="Edit" onClick={() => setEditing(a)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Reissue certificate" onClick={() => setReissuing(a)}>
                    <RotateCcw className="size-3.5" />
                  </IconButton>
                  <IconButton label="Remove" onClick={() => setDeleting(a)} className="hover:!text-bad">
                    <Trash2 className="size-3.5" />
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
      {reissuing && (
        <Modal
          open
          onClose={() => setReissuing(null)}
          title={`Reissue the certificate for ${reissuing.name}?`}
          description="The current certificate stops working immediately, until you update the agent with the new one."
        >
          <ModalActions>
            <Button variant="ghost" onClick={() => setReissuing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              icon={<RotateCcw className="size-3.5" />}
              onClick={() => reissue(reissuing)}
            >
              Reissue
            </Button>
          </ModalActions>
        </Modal>
      )}
      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Remove ${deleting.name}?`}
          description="The control server stops connecting to this agent and forgets its certificate. Remember to remove the containers from the machine too."
        >
          <ModalActions>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              icon={<Trash2 className="size-3.5" />}
              onClick={() => remove(deleting)}
            >
              Remove agent
            </Button>
          </ModalActions>
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
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. NAS"
            autoFocus
            required
            maxLength={64}
          />
        </Field>
        <Field
          label="Tailscale host name or IP"
          hint={
            <>
              How the control server reaches the agent. Short MagicDNS names are expanded with your tailnet domain.
              {!agent && (
                <>
                  {" "}
                  Defaults to <Code>{defaultAddress}</Code>.
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
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {agent ? "Save" : "Create agent"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
