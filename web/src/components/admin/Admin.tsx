import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { href } from "../../lib/router";
import type { SystemInfo } from "../../lib/types";
import { Card, CodeBlock, cx, ErrorNote, PageHeader, SectionHeader, Spinner } from "../ui";
import { Agents } from "./Agents";
import { Passkeys } from "./Passkeys";

type Tab = "agents" | "passkeys" | "system";

export function Admin({ tab, onChanged }: { tab: Tab; onChanged: () => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "agents", label: "Agents" },
    { id: "passkeys", label: "Passkeys" },
    { id: "system", label: "System" },
  ];
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Settings" description="Agents, passkeys and the control server.">
        <nav className="-mb-px flex gap-5">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={href({ name: "admin", tab: t.id })}
              aria-current={tab === t.id ? "page" : undefined}
              className={cx(
                "border-b-2 pb-2.5 text-[13px] font-medium transition-colors duration-75",
                tab === t.id ? "border-fg text-fg" : "border-transparent text-fg-faint hover:text-fg",
              )}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </PageHeader>
      <div className="max-w-4xl px-5 py-6 sm:px-8">
        {tab === "agents" && <Agents onChanged={onChanged} />}
        {tab === "passkeys" && <Passkeys />}
        {tab === "system" && <System />}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 text-[13px] sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-fg-faint">{label}</dt>
      <dd className="min-w-0 break-all text-fg">{children}</dd>
    </div>
  );
}

function System() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .system()
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!info)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <SectionHeader title="System" description="About this control server." />
        <Card>
          <dl className="divide-y divide-line">
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
      </div>
      <div className="space-y-3">
        <SectionHeader
          title="Control server compose file"
          description="For reference or a reinstall. Tailscale Serve terminates HTTPS with a certificate for your tailnet name and proxies to Driftwatch."
        />
        <CodeBlock filename="compose.yaml" code={info.controlSnippet} maxHeight="30rem" />
      </div>
    </div>
  );
}
