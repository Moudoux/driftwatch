import { useEffect, useState } from "react";

/**
 * Hash routes:
 *   #/                          overview
 *   #/m/<machine>/c/<container> one container
 *   #/m/<machine>/p/<project>   every container in a compose project
 *   #/admin/<tab>               admin
 *   #/invite/<token>            register a passkey from an invite link
 */
export type Route =
  | { name: "overview" }
  | { name: "container"; machine: string; container: string }
  | { name: "project"; machine: string; project: string }
  | { name: "admin"; tab: "agents" | "passkeys" | "system" }
  | { name: "invite"; token: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "m" && parts[1] && parts[2] === "c" && parts[3])
    return { name: "container", machine: parts[1], container: parts[3] };
  if (parts[0] === "m" && parts[1] && parts[2] === "p" && parts[3])
    return { name: "project", machine: parts[1], project: parts[3] };
  if (parts[0] === "admin") {
    const tab = parts[1] === "passkeys" || parts[1] === "system" ? parts[1] : "agents";
    return { name: "admin", tab };
  }
  if (parts[0] === "invite" && parts[1]) return { name: "invite", token: parts[1] };
  return { name: "overview" };
}

export function href(route: Route): string {
  const e = encodeURIComponent;
  switch (route.name) {
    case "overview":
      return "#/";
    case "container":
      return `#/m/${e(route.machine)}/c/${e(route.container)}`;
    case "project":
      return `#/m/${e(route.machine)}/p/${e(route.project)}`;
    case "admin":
      return `#/admin/${route.tab}`;
    case "invite":
      return `#/invite/${e(route.token)}`;
  }
}

export function navigate(route: Route) {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
