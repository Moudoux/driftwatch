export function relativeTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "never";
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 10) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function bytes(n: number): string {
  if (!n) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Log timestamp (unix micros) as local HH:MM:SS.mmm, with the date if not today. */
export function logTime(micros: number, withDate: boolean): string {
  const d = new Date(micros / 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

export function isoTime(micros: number): string {
  return new Date(micros / 1000).toISOString();
}

/** Stable colour per container name, used to tag lines in merged views. */
const TAG_COLORS = [
  "#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb923c", "#4ade80",
  "#e879f9", "#2dd4bf",
];
export function tagColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}

export function stateColor(state: string): string {
  switch (state) {
    case "running":
      return "bg-emerald-400";
    case "restarting":
      return "bg-amber-400";
    case "paused":
      return "bg-sky-400";
    case "dead":
      return "bg-red-500";
    case "created":
      return "bg-zinc-500";
    default:
      return "bg-zinc-600";
  }
}

export function health(status: string): "healthy" | "unhealthy" | "starting" | null {
  if (status.includes("(healthy)")) return "healthy";
  if (status.includes("(unhealthy)")) return "unhealthy";
  if (status.includes("(health: starting)")) return "starting";
  return null;
}
