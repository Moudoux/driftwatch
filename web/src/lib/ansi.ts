// Minimal ANSI SGR (colour/style) parser for log lines. Other escape
// sequences (cursor movement, OSC titles, ...) are stripped.

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

// Theme-aware: the 16 basic colours resolve to CSS variables in index.css.
const BASE = Array.from({ length: 8 }, (_, i) => `var(--ansi-${i})`);
const BRIGHT = Array.from({ length: 8 }, (_, i) => `var(--ansi-${i + 8})`);

function xterm256(n: number): string | undefined {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  if (n < 256) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
  return undefined;
}

// CSI ... final byte, or OSC ... BEL/ST, or a lone two-char escape.
const ESC_RE = /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function hasAnsi(s: string): boolean {
  return s.includes("\x1b");
}

export function stripAnsi(s: string): string {
  return hasAnsi(s) ? s.replace(ESC_RE, "") : s;
}

export function parseAnsi(input: string): Segment[] {
  if (!hasAnsi(input)) return [{ text: input }];
  const out: Segment[] = [];
  let style: Omit<Segment, "text"> = {};
  let last = 0;
  ESC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC_RE.exec(input))) {
    if (m.index > last) out.push({ text: input.slice(last, m.index), ...style });
    last = ESC_RE.lastIndex;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(/[;:]/).map((x) => parseInt(x || "0", 10));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) style.bold = style.dim = false;
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c >= 30 && c <= 37) style.fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) style.bg = BASE[c - 40];
      else if (c >= 100 && c <= 107) style.bg = BRIGHT[c - 100];
      else if (c === 39) style.fg = undefined;
      else if (c === 49) style.bg = undefined;
      else if (c === 38 || c === 48) {
        let color: string | undefined;
        if (codes[i + 1] === 5) {
          color = xterm256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2) {
          color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
        if (c === 38) style.fg = color;
        else style.bg = color;
      }
    }
  }
  if (last < input.length) out.push({ text: input.slice(last), ...style });
  return out;
}
