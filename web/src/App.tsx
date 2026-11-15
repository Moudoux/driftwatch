import { Box, Layers } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, onUnauthorized } from "./lib/api";
import { useRoute } from "./lib/router";
import type { AuthStatus, Machine } from "./lib/types";
import { Admin } from "./components/admin/Admin";
import { InviteRegister, Login } from "./components/Login";
import { LogViewer } from "./components/LogViewer";
import { Overview } from "./components/Overview";
import { Sidebar } from "./components/Sidebar";
import { EmptyState, Spinner } from "./components/ui";

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const checkAuth = useCallback(() => {
    api
      .authStatus()
      .then((s) => {
        setAuth(s);
        setAuthError(null);
      })
      .catch((e) => setAuthError(e.message));
  }, []);

  useEffect(checkAuth, [checkAuth]);
  useEffect(() => onUnauthorized(checkAuth), [checkAuth]);

  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        {authError ? `Cannot reach the control server: ${authError}` : <Spinner />}
      </div>
    );
  }
  if (route.name === "invite" && !auth.authenticated) {
    return <InviteRegister token={route.token} onDone={checkAuth} />;
  }
  if (!auth.authenticated) return <Login status={auth} onSignedIn={checkAuth} />;
  return <Shell onLogout={async () => {
    await api.logout().catch(() => {});
    checkAuth();
  }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setMachines(refresh ? await api.refreshMachines() : await api.machines());
    } catch {
      /* 401s are handled globally */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  // An invite link opened while signed in: nothing to do.
  useEffect(() => {
    if (route.name === "invite") window.location.hash = "#/admin/passkeys";
  }, [route]);

  let main: React.ReactNode;
  if (route.name === "container" || route.name === "project") {
    const m = machines.find((x) => x.id === route.machine);
    const containers =
      route.name === "container"
        ? (m?.containers.filter((c) => c.name === route.container) ?? [])
        : (m?.containers.filter((c) => c.project === route.project) ?? []);
    if (!m || containers.length === 0) {
      main = loading && machines.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState icon={route.name === "project" ? <Layers className="size-5" /> : <Box className="size-5" />} title="Not found">
            This {route.name === "project" ? "compose project" : "container"} doesn't exist on{" "}
            {m?.name ?? "that machine"} anymore.
          </EmptyState>
        </div>
      );
    } else {
      const title =
        route.name === "project"
          ? route.project
          : (containers[0].project && containers[0].service) || containers[0].name;
      main = (
        <LogViewer
          key={`${m.id}:${route.name}:${route.name === "project" ? route.project : route.container}`}
          machine={m}
          containers={containers}
          title={title}
          project={containers[0].project ?? undefined}
        />
      );
    }
  } else if (route.name === "admin") {
    main = <Admin tab={route.tab} onChanged={() => void load(true)} />;
  } else {
    main = <Overview machines={machines} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar machines={machines} route={route} loading={loading} onRefresh={() => void load(true)} onLogout={onLogout} />
      <main className="flex min-w-0 flex-1 flex-col">{main}</main>
    </div>
  );
}
