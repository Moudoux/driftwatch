import { Info, KeyRound, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { href } from "../../lib/router";
import type { SystemInfo } from "../../lib/types";
import { Card, CodeBlock, cx, Spinner } from "../ui";
import { Agents } from "./Agents";
import { Passkeys } from "./Passkeys";

type Tab = "agents" | "passkeys" | "system";

export function Admin({ tab, onChanged }: { tab: Tab; onChanged: () => void }) {
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "agents", label: "Agents", icon: <Server className="size-4" /> },
    { id: "passkeys", label: "Passkeys", icon: <KeyRound className="size-4" /> },
    { id: "system", label: "System", icon: <Info className="size-4" /> },
  ];
  return (
    <div className="h-full overflow-y-auto">
      <div className="bg-grid border-b border-white/[0.06] px-8 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Admin</h1>
        <p className="mt-1 text-sm text-zinc-500">Manage agents, passkeys and the control server.</p>
        <nav className="mt-6 flex gap-1">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={href({ name: "admin", tab: t.id })}
              className={cx(
                "-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm font-medium transition-colors",
                tab === t.id ? "border-cyan-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300",
              )}
            >
              {t.icon}
              {t.label}
            </a>
          ))}
        </nav>
      </div>
      <div className="max-w-5xl px-8 py-8">
        {tab === "agents" && <Agents onChanged={onChanged} />}
        {tab === "passkeys" && <Passkeys />}
        {tab === "system" && <System />}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-4 px-5 py-3 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all text-zinc-200">{children}</dd>
    </div>
  );
}

function System() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    void api.system().then(setInfo);
  }, []);
  if (!info)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">System</h2>
        <p className="mt-0.5 text-sm text-zinc-500">About this control server.</p>
      </div>
      <Card>
        <dl className="divide-y divide-white/[0.05]">
          <Row label="Version">{info.version}</Row>
          <Row label="Public URL">{info.publicUrl}</Row>
          <Row label="Passkey domain">{info.rpId}</Row>
          <Row label="Local collection">{info.localCollection ? "Enabled" : "Disabled"}</Row>
          <Row label="Agent image">
            <span className="font-mono text-xs">{info.image}</span>
          </Row>
          <Row label="CA fingerprint">
            <span className="font-mono text-xs">{info.caFingerprint.match(/.{1,2}/g)?.join(":")}</span>
          </Row>
        </dl>
      </Card>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-zinc-200">Control server compose file</h3>
        <p className="mb-3 text-sm text-zinc-500">
          For reference or a reinstall. Tailscale Serve terminates HTTPS with a certificate for your tailnet name and
          proxies to Driftwatch.
        </p>
        <CodeBlock filename="compose.yaml" code={info.controlSnippet} maxHeight="30rem" />
      </div>
    </div>
  );
}
