import { KeyRound, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { AgentRow, AgentSnippet } from "../../lib/types";
import { CodeBlock, Modal, Tabs } from "../ui";

export function SnippetDialog({
  open,
  onClose,
  agent,
  snippet,
  reissued,
}: {
  open: boolean;
  onClose: () => void;
  agent: AgentRow;
  snippet: AgentSnippet;
  reissued?: boolean;
}) {
  const [mode, setMode] = useState<"env" | "inline">("env");
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={reissued ? `New certificate for ${agent.name}` : `Deploy the ${agent.name} agent`}
      description="Copy these onto the machine, then start it with docker compose up -d."
    >
      <div className="space-y-5">
        <div className="flex gap-3 rounded-xl bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-200/90 ring-1 ring-inset ring-amber-400/20">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            The agent's private key is shown <strong>only now</strong> and is not stored by the control server. If
            you lose it, reissue the certificate.
            {reissued && " The previous certificate stops working immediately."}
          </div>
        </div>

        <ol className="space-y-2 text-sm text-zinc-400">
          <li className="flex gap-3">
            <Step n={1} />
            <span>
              Create a Tailscale auth key in the{" "}
              <a
                className="text-cyan-300 hover:underline"
                href="https://login.tailscale.com/admin/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                admin console
              </a>{" "}
              and put it in <code className="text-zinc-300">TS_AUTHKEY</code>.
            </span>
          </li>
          <li className="flex gap-3">
            <Step n={2} />
            <span>
              Save the files below in a new folder on the machine. The node joins your tailnet as{" "}
              <code className="text-zinc-300">{snippet.tailscaleHostname}</code>.
            </span>
          </li>
          <li className="flex gap-3">
            <Step n={3} />
            <span>
              Run <code className="text-zinc-300">docker compose up -d</code>. The machine turns green here within a few
              seconds.
            </span>
          </li>
        </ol>

        <div className="flex items-center justify-between">
          <Tabs
            value={mode}
            onChange={setMode}
            items={[
              { value: "env", label: "compose.yaml + .env" },
              { value: "inline", label: "Single compose file" },
            ]}
          />
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            <KeyRound className="size-3.5" /> mTLS, pinned certificate
          </span>
        </div>

        {mode === "env" ? (
          <div className="space-y-3">
            <CodeBlock filename="compose.yaml" code={snippet.compose} maxHeight="16rem" />
            <CodeBlock filename=".env" code={snippet.env} maxHeight="10rem" />
          </div>
        ) : (
          <CodeBlock filename="compose.yaml" code={snippet.composeInline} maxHeight="26rem" />
        )}
      </div>
    </Modal>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-semibold text-zinc-300 ring-1 ring-white/10">
      {n}
    </span>
  );
}
