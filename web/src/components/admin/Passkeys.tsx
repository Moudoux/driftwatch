import { Fingerprint, KeyRound, Link2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDate, relativeTime } from "../../lib/format";
import type { Passkey } from "../../lib/types";
import { guessDeviceName, registerPasskey } from "../../lib/webauthn";
import { Badge, Button, Card, CodeBlock, ErrorNote, Field, IconButton, Input, Modal, Spinner } from "../ui";

export function Passkeys() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);

  const load = useCallback(() => {
    api
      .passkeys()
      .then(setKeys)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const remove = async (p: Passkey) => {
    if (!confirm(`Delete the passkey "${p.name}"? Devices using it will be signed out.`)) return;
    try {
      await api.deletePasskey(p.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Passkeys</h2>
          <p className="mt-0.5 text-sm text-zinc-500">Every passkey here can sign in. There are no passwords.</p>
        </div>
        <div className="flex gap-2">
          <Button
            icon={<Link2 className="size-4" />}
            onClick={async () => {
              try {
                setInvite(await api.createInvite());
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Invite another device
          </Button>
          <Button variant="primary" icon={<Fingerprint className="size-4" />} onClick={() => setAdding(true)}>
            Add passkey here
          </Button>
        </div>
      </div>
      <ErrorNote error={error} />

      <Card className="overflow-hidden">
        {keys === null ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {keys.map((p) => (
              <li key={p.id} className="flex items-center gap-4 px-5 py-4">
                <div className="flex size-9 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08]">
                  <KeyRound className="size-4 text-zinc-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-100">{p.name}</span>
                    {p.current && <Badge tone="cyan">this session</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    Added {formatDate(p.createdAt)} · last used {relativeTime(p.lastUsedAt)}
                  </div>
                </div>
                <IconButton label="Rename" onClick={() => setRenaming(p)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton
                  label={keys.length <= 1 ? "You cannot delete your last passkey" : "Delete"}
                  onClick={() => remove(p)}
                  disabled={keys.length <= 1}
                  className="hover:!text-red-300"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-zinc-600">
        Locked out? Run <code className="text-zinc-400">docker exec -it driftwatch driftwatch invite</code> on the control
        machine for a one-time registration link.
      </p>

      <AddPasskey open={adding} onClose={() => setAdding(false)} onAdded={load} />
      {renaming && <Rename passkey={renaming} onClose={() => setRenaming(null)} onDone={load} />}
      {invite && (
        <Modal
          open
          onClose={() => setInvite(null)}
          title="Invite another device"
          description={`Open this link on the other device. It works once and expires at ${new Date(invite.expiresAt * 1000).toLocaleTimeString()}.`}
          wide
        >
          <CodeBlock filename="invite link" code={invite.url} />
        </Modal>
      )}
    </div>
  );
}

function AddPasskey({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Add a passkey on this device">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await registerPasskey(name);
            onAdded();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} icon={<Fingerprint className="size-4" />}>
            Create passkey
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Rename({ passkey, onClose, onDone }: { passkey: Passkey; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(passkey.name);
  return (
    <Modal open onClose={onClose} title="Rename passkey">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.renamePasskey(passkey.id, name);
          onDone();
          onClose();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
