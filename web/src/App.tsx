import { Box, Layers, Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onUnauthorized } from "./lib/api";
import { useRoute } from "./lib/router";
import type { AuthStatus, ContainerInfo, Machine } from "./lib/types";
import { Admin } from "./components/admin/Admin";
import { InviteRegister, Login } from "./components/Login";
import { Logo } from "./components/Logo";
import { LogViewer } from "./components/LogViewer";
import { Overview } from "./components/Overview";
import { Sidebar } from "./components/Sidebar";
import { cx, EmptyState, IconButton, Spinner } from "./components/ui";

const POLL_MS = 5000;

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
      <div className="flex h-full items-center justify-center text-[13px] text-fg-muted">
        {authError ? `Cannot reach the control server: ${authError}` : <Spinner />}
      </div>
    );
  }
  if (route.name === "invite" && !auth.authenticated) {
    return <InviteRegister token={route.token} onDone={checkAuth} />;
  }
  if (!auth.authenticated) return <Login status={auth} onSignedIn={checkAuth} />;
  return (
    <Shell
      onLogout={async () => {
        await api.logout().catch(() => {});
        checkAuth();
      }}
    />
  );
}

/**
 * Polls the machine list. Background polls only update state when the payload
 * actually changed, and pause while the tab is hidden.
 */
function useMachines() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lastJson = useRef("");

  const apply = useCallback((data: Machine[]) => {
    const json = JSON.stringify(data);
    if (json !== lastJson.current) {
      lastJson.current = json;
      setMachines(data);
    }
    setLoaded(true);
  }, []);

  const poll = useCallback(() => {
    api
      .machines()
      .then(apply)
      .catch(() => {
        /* 401s are handled globally */
      });
  }, [apply]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      apply(await api.refreshMachines());
    } catch {
      /* handled globally */
    } finally {
      setRefreshing(false);
    }
  }, [apply]);

  useEffect(() => {
    poll();
    const t = setInterval(() => {
      if (!document.hidden) poll();
    }, POLL_MS);
    const onVis = () => !document.hidden && poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  return { machines, loaded, refreshing, refresh };
}

/** Keeps the same array identity while the containers' content is unchanged. */
function useStableContainers(containers: ContainerInfo[]): ContainerInfo[] {
  const key = JSON.stringify(containers);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => containers, [key]);
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const { machines, loaded, refreshing, refresh } = useMachines();
  const [navOpen, setNavOpen] = useState(false);

  // An invite link opened while signed in: nothing to do.
  useEffect(() => {
    if (route.name === "invite") window.location.hash = "#/admin/passkeys";
  }, [route]);

  // Close the mobile drawer on navigation.
  useEffect(() => setNavOpen(false), [route]);

  const m =
    route.name === "container" || route.name === "project" ? machines.find((x) => x.id === route.machine) : undefined;
  const containers = useStableContainers(
    !m
      ? []
      : route.name === "container"
        ? m.containers.filter((c) => c.name === route.container)
        : route.name === "project"
          ? m.containers.filter((c) => c.project === route.project)
          : [],
  );

  let main: React.ReactNode;
  if (route.name === "container" || route.name === "project") {
    if (!m || containers.length === 0) {
      main = !loaded ? (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            icon={route.name === "project" ? <Layers className="size-5" /> : <Box className="size-5" />}
            title="Not found"
          >
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
          machineId={m.id}
          machineName={m.name}
          online={m.online}
          containers={containers}
          title={title}
          project={containers[0].project ?? undefined}
          isProject={route.name === "project"}
        />
      );
    }
  } else if (route.name === "admin") {
    main = <Admin tab={route.tab} onChanged={() => void refresh()} />;
  } else {
    main = <Overview machines={machines} loaded={loaded} />;
  }

  return (
    <div className="flex h-full">
      {navOpen && <div className="fixed inset-0 z-30 animate-fade-in bg-overlay md:hidden" onClick={() => setNavOpen(false)} />}
      <div
        className={cx(
          "fixed inset-y-0 left-0 z-40 transition-transform duration-150 md:static md:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar
          machines={machines}
          route={route}
          loaded={loaded}
          refreshing={refreshing}
          onRefresh={refresh}
          onLogout={onLogout}
        />
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
          <IconButton label="Menu" onClick={() => setNavOpen(true)}>
            <Menu className="size-4" />
          </IconButton>
          <a href="#/">
            <Logo />
          </a>
        </div>
        <div className="min-h-0 flex-1">{main}</div>
      </main>
    </div>
  );
}
