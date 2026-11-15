import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { AgentRow, AgentSnippet } from "../../lib/types";
import { Code, CodeBlock, Modal, Segmented } from "../ui";

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
      description={
        <>
          Copy these onto the machine, then start it with <Code>docker compose up -d</Code>.
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-2.5 rounded-md border border-warn/30 px-3 py-2.5 text-[13px] leading-relaxed text-fg">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div>
            The agent's private key is shown <strong className="font-semibold">only now</strong> and is not stored by
            the control server. If you lose it, reissue the certificate.
            {reissued && " The previous certificate stops working immediately."}
          </div>
        </div>

        <ol className="space-y-2 text-[13px] leading-relaxed text-fg-muted">
          <li className="flex gap-3">
            <Step n={1} />
            <span>
              Create a Tailscale auth key in the{" "}
              <a
                className="text-accent hover:underline"
                href="https://login.tailscale.com/admin/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                admin console
              </a>{" "}
              and put it in <Code>TS_AUTHKEY</Code>.
            </span>
          </li>
          <li className="flex gap-3">
            <Step n={2} />
            <span>
              Save the files below in a new folder on the machine. The node joins your tailnet as{" "}
              <Code>{snippet.tailscaleHostname}</Code>.
            </span>
          </li>
          <li className="flex gap-3">
            <Step n={3} />
            <span>
              Run <Code>docker compose up -d</Code>. The machine turns green here within a few seconds.
            </span>
          </li>
        </ol>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            value={mode}
            onChange={setMode}
            items={[
              { value: "env", label: "compose.yaml + .env" },
              { value: "inline", label: "Single compose file" },
            ]}
          />
          <span className="text-xs text-fg-faint">mTLS with a pinned certificate</span>
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
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] font-medium tabular-nums text-fg-muted">
      {n}
    </span>
  );
}
