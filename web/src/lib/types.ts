export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  project: string | null;
  service: string | null;
}

export interface HostInfo {
  version: string;
  hostname: string;
  dockerVersion: string;
  os: string;
  arch: string;
  cpus: number;
  memTotal: number;
}

export interface MachineStatus {
  online: boolean;
  checkedAt: number | null;
  lastSeen: number | null;
  error: string | null;
  latencyMs: number | null;
  info: HostInfo | null;
  containers: ContainerInfo[];
}

export interface Machine extends MachineStatus {
  id: string;
  name: string;
  kind: "local" | "agent";
  address: string | null;
}

export interface AgentRow {
  id: string;
  name: string;
  address: string;
  port: number;
  fingerprint: string;
  createdAt: number;
  certIssuedAt: number;
}

export interface AgentSnippet {
  compose: string;
  env: string;
  composeInline: string;
  tailscaleHostname: string;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  current: boolean;
}

export interface SystemInfo {
  version: string;
  publicUrl: string;
  rpId: string;
  caFingerprint: string;
  localCollection: boolean;
  image: string;
  controlSnippet: string;
}

export interface AuthStatus {
  authenticated: boolean;
  setupRequired: boolean;
  rpId: string;
  version: string;
}

/** Events from /api/logs, mirroring `LogEvent` in the Rust code. */
export type LogEvent =
  | { k: "l"; c: string; s: "o" | "e"; t: number; m: string }
  | { k: "s"; c: string; state: string; msg?: string };
