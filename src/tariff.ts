import type { Zone } from "./config";

const toMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

/** Зона может переходить через полночь (23:00 → 07:00) */
function inZone(z: Zone, m: number): boolean {
  const a = toMin(z.from), b = toMin(z.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Каждая минута суток должна попадать ровно в одну зону */
export function validateZones(zones: Zone[]): void {
  for (let m = 0; m < 1440; m++) {
    const n = zones.filter((z) => inZone(z, m)).length;
    if (n !== 1) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      throw new Error(`Тарифные зоны: время ${hh}:${mm} попадает в ${n} зон(ы), нужно ровно в одну`);
    }
  }
}

function zoneAt(zones: Zone[], d: Date): Zone {
  const m = d.getHours() * 60 + d.getMinutes();
  return zones.find((z) => inZone(z, m))!;
}

export interface EnergyResult {
  kwh: number;
  cost: number;
  byZone: Record<string, { kwh: number; cost: number }>;
}

/** Считает электричество с шагом в минуту, поэтому границы зон учитываются точно */
export function energyCost(startMs: number, endMs: number, watts: number, zones: Zone[]): EnergyResult {
  const res: EnergyResult = { kwh: 0, cost: 0, byZone: {} };
  let t = startMs;
  while (t < endMs) {
    const nextMinute = (Math.floor(t / 60000) + 1) * 60000;
    const seg = Math.min(nextMinute, endMs);
    const kwh = ((seg - t) / 3.6e6) * (watts / 1000);
    const z = zoneAt(zones, new Date(t));
    const cost = kwh * z.price;
    res.kwh += kwh;
    res.cost += cost;
    const slot = (res.byZone[z.name] ??= { kwh: 0, cost: 0 });
    slot.kwh += kwh;
    slot.cost += cost;
    t = seg;
  }
  return res;
}
