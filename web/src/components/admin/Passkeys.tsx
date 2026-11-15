import { Fingerprint, KeyRound, Link2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDate, relativeTime } from "../../lib/format";
import type { Passkey } from "../../lib/types";
import { guessDeviceName, registerPasskey } from "../../lib/webauthn";
import {
  Badge,
  Button,
  Card,
  Code,
  CodeBlock,
  ErrorNote,
  Field,
  IconButton,
  Input,
  Modal,
  ModalActions,
  SectionHeader,
  Spinner,
} from "../ui";

export function Passkeys() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [deleting, setDeleting] = useState<Passkey | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);

  const load = useCallback(() => {
    api
      .passkeys()
      .then(setKeys)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const remove = async (p: Passkey) => {
    try {
      await api.deletePasskey(p.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setDeleting(null);
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Passkeys"
        description="Every passkey here can sign in. There are no passwords."
        actions={
          <>
            <Button
              icon={<Link2 className="size-3.5" />}
              onClick={async () => {
                try {
                  setInvite(await api.createInvite());
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Invite device
            </Button>
            <Button variant="primary" icon={<Fingerprint className="size-3.5" />} onClick={() => setAdding(true)}>
              Add passkey here
            </Button>
          </>
        }
      />
      <ErrorNote error={error} />

      <Card className="overflow-hidden">
        {keys === null ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {keys.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <KeyRound className="size-4 shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{p.name}</span>
                    {p.current && <Badge tone="accent">This session</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-fg-faint">
                    Added {formatDate(p.createdAt)} · last used {relativeTime(p.lastUsedAt)}
                  </div>
                </div>
                <IconButton label="Rename" onClick={() => setRenaming(p)}>
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton
                  label={keys.length <= 1 ? "You cannot delete your last passkey" : "Delete"}
                  onClick={() => setDeleting(p)}
                  disabled={keys.length <= 1}
                  className="hover:!text-bad"
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-fg-faint">
        Locked out? Run <Code>docker exec -it driftwatch driftwatch invite</Code> on the control machine for a one-time
        registration link.
      </p>

      <AddPasskey open={adding} onClose={() => setAdding(false)} onAdded={load} />
      {renaming && <Rename passkey={renaming} onClose={() => setRenaming(null)} onDone={load} />}
      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={`Delete "${deleting.name}"?`}
          description="Devices using this passkey are signed out and can't sign in with it again."
        >
          <ModalActions>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => remove(deleting)}>
              Delete passkey
            </Button>
          </ModalActions>
        </Modal>
      )}
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
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} icon={<Fingerprint className="size-3.5" />}>
            Create passkey
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function Rename({ passkey, onClose, onDone }: { passkey: Passkey; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(passkey.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="Rename passkey">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.renamePasskey(passkey.id, name);
            onDone();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
        <ErrorNote error={error} />
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
