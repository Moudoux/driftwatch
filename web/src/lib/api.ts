import type {
  AgentRow,
  AgentSnippet,
  AuthStatus,
  Machine,
  MachineStatus,
  Passkey,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Called whenever the server says the session is gone. */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && !path.startsWith("/auth/")) {
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

export const api = {
  authStatus: () => get<AuthStatus>("/auth/status"),
  loginBegin: () => post<{ challengeId: string; options: any }>("/auth/login/begin"),
  loginFinish: (challengeId: string, credential: unknown) =>
    post<{ ok: true }>("/auth/login/finish", { challengeId, credential }),
  registerBegin: (invite?: string) =>
    post<{ challengeId: string; options: any }>("/auth/register/begin", { invite }),
  registerFinish: (challengeId: string, name: string, credential: unknown) =>
    post<{ ok: true }>("/auth/register/finish", { challengeId, name, credential }),
  logout: () => post<{ ok: true }>("/auth/logout"),

  machines: () => get<Machine[]>("/machines"),
  refreshMachines: () => post<Machine[]>("/machines/refresh"),

  agents: () => get<{ agent: AgentRow; status: MachineStatus }[]>("/agents"),
  createAgent: (a: { name: string; address?: string; port?: number }) =>
    post<{ agent: AgentRow; snippet: AgentSnippet }>("/agents", a),
  updateAgent: (id: string, a: { name?: string; address?: string; port?: number }) =>
    patch<AgentRow>(`/agents/${encodeURIComponent(id)}`, a),
  reissueAgent: (id: string) =>
    post<{ agent: AgentRow; snippet: AgentSnippet }>(`/agents/${encodeURIComponent(id)}/reissue`),
  deleteAgent: (id: string) => del<{ ok: true }>(`/agents/${encodeURIComponent(id)}`),

  passkeys: () => get<Passkey[]>("/passkeys"),
  renamePasskey: (id: string, name: string) => patch<{ ok: true }>(`/passkeys/${id}`, { name }),
  deletePasskey: (id: string) => del<{ ok: true }>(`/passkeys/${id}`),
  createInvite: () => post<{ url: string; expiresAt: number }>("/invites"),

  system: () => get<SystemInfo>("/system"),
};

export function logsUrl(machine: string, containers: string[], tail: number, since?: number) {
  const q = new URLSearchParams({ machine, containers: containers.join(","), tail: String(tail) });
  if (since !== undefined) q.set("since", String(since));
  return `/api/logs?${q}`;
}
