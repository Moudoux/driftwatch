import { Fingerprint, KeyRound, ShieldCheck, Terminal } from "lucide-react";
import { useState } from "react";
import { navigate } from "../lib/router";
import type { AuthStatus } from "../lib/types";
import { guessDeviceName, passkeysSupported, registerPasskey, signInWithPasskey } from "../lib/webauthn";
import { LogoMark } from "./Logo";
import { Button, ErrorNote, Field, Input } from "./ui";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-grid flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px] animate-pop-in">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoMark className="mb-5 size-14 drop-shadow-[0_8px_24px_rgb(34_211_238/0.35)]" />
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
            <span className="text-gradient">Driftwatch</span>
          </h1>
          <p className="mt-1.5 text-sm text-zinc-500">Live container logs from every machine</p>
        </div>
        <div className="rounded-2xl bg-ink-800/80 p-6 ring-1 ring-white/[0.08] backdrop-blur-xl shadow-[0_24px_80px_-24px_rgb(0_0_0/0.9)]">
          {children}
        </div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-zinc-600">
          <ShieldCheck className="size-3.5" /> Passkey only · no passwords
        </p>
      </div>
    </div>
  );
}

function Unsupported() {
  return (
    <ErrorNote error="This browser does not support passkeys, or the page is not served over HTTPS." />
  );
}

export function Login({ status, onSignedIn }: { status: AuthStatus; onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (status.setupRequired) {
    return (
      <Shell>
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Terminal className="size-4 text-cyan-300" /> Finish setting up
          </div>
          <p className="text-sm leading-relaxed text-zinc-400">
            No passkey is registered yet. On the machine running the control server, create a one-time sign-up
            link:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-ink-950 px-3 py-2.5 font-mono text-[12.5px] text-cyan-200 ring-1 ring-white/[0.08]">
            docker exec -it driftwatch driftwatch invite
          </pre>
          <p className="text-xs text-zinc-500">
            Replace <code className="text-zinc-400">driftwatch</code> with your container name. Open the printed
            link in this browser to register a passkey.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-4">
        {!passkeysSupported() && <Unsupported />}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={signIn}
          loading={busy}
          icon={<Fingerprint className="size-5" />}
          disabled={!passkeysSupported()}
        >
          Sign in with passkey
        </Button>
        <ErrorNote error={error} />
      </div>
    </Shell>
  );
}

export function InviteRegister({ token, onDone }: { token: string; onDone: () => void }) {
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(name, token);
      navigate({ name: "overview" });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form onSubmit={register} className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <KeyRound className="size-4 text-cyan-300" /> Register a passkey
        </div>
        <p className="text-sm text-zinc-400">
          This invite link works once. Your passkey stays on this device or in your password manager.
        </p>
        {!passkeysSupported() && <Unsupported />}
        <Field label="Passkey name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          loading={busy}
          icon={<Fingerprint className="size-5" />}
          disabled={!passkeysSupported()}
        >
          Create passkey
        </Button>
        <ErrorNote error={error} />
      </form>
    </Shell>
  );
}
