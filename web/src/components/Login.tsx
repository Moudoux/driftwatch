import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { navigate } from "../lib/router";
import type { AuthStatus } from "../lib/types";
import { guessDeviceName, passkeysSupported, registerPasskey, signInWithPasskey } from "../lib/webauthn";
import { LogoMark } from "./Logo";
import { Button, Code, ErrorNote, Field, Input } from "./ui";

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-[360px] animate-rise">
        <LogoMark className="mb-6 size-8" />
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        <p className="mt-1 text-[13px] text-fg-muted">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <p className="mt-8 text-xs text-fg-faint">Driftwatch uses passkeys only. There are no passwords.</p>
      </div>
    </div>
  );
}

function Unsupported() {
  return <ErrorNote error="This browser does not support passkeys, or the page is not served over HTTPS." />;
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
      <Shell title="Finish setting up" subtitle="No passkey is registered yet.">
        <div className="space-y-3 text-[13px] leading-relaxed text-fg-muted">
          <p>On the machine running the control server, create a one-time sign-up link:</p>
          <pre className="overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2.5 font-mono text-xs text-fg">
            docker exec -it driftwatch driftwatch invite
          </pre>
          <p className="text-xs text-fg-faint">
            Replace <Code>driftwatch</Code> with your container name, then open the printed link in this browser.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Sign in to Driftwatch" subtitle="Live container logs from every machine.">
      <div className="space-y-3">
        {!passkeysSupported() && <Unsupported />}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={signIn}
          loading={busy}
          icon={<Fingerprint className="size-4" />}
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
    <Shell
      title="Register a passkey"
      subtitle="This invite link works once. The passkey stays on this device or in your password manager."
    >
      <form onSubmit={register} className="space-y-4">
        {!passkeysSupported() && <Unsupported />}
        <Field label="Passkey name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus className="[&_input]:h-9" />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          loading={busy}
          icon={<Fingerprint className="size-4" />}
          disabled={!passkeysSupported()}
        >
          Create passkey
        </Button>
        <ErrorNote error={error} />
      </form>
    </Shell>
  );
}
