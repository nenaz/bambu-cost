import type { Spool } from "./db";

export const spoolStatus = (s: Spool, low: number) =>
  s.archived ? "archived" : s.remaining_g <= 0 ? "empty" : s.remaining_g < low ? "low" : "ok";

const rgb = (h: string) => {
  const m = /^#?([0-9a-f]{6})/i.exec(h || "");
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};
const dist = (a: string, b: string) => {
  const x = rgb(a), y = rgb(b);
  return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999;
};

/** Основа типа: "PLA Lite", "PLA+" и "PLA-CF" все считаются PLA */
const base = (t: string) => (/[a-z]+/i.exec(t || "")?.[0] ?? "").toLowerCase();

/** Катушки того же типа пластика, ближайший цвет первым */
export const rankSpools = (f: { type: string; color: string }, spools: Spool[]) =>
  spools
    .filter((s) => !s.archived && base(s.type) === base(f.type))
    .sort((a, b) => dist(a.hex, f.color) - dist(b.hex, f.color));

export const pickSpool = (f: { type: string; color: string }, planned: number | undefined, spools: Spool[]) =>
  planned ? spools.find((s) => s.id === planned) : rankSpools(f, spools)[0];
