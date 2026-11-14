import type { Settings } from "./config";
import { energyCost } from "./tariff";

export interface Costs { grams: number | null; kwh: number; electricity: number; filament: number; extra: number; total: number }

/** uses - расход по слотам; perKg = null → цена по умолчанию из настроек */
export function computeCosts(
  cfg: Settings, startMs: number, endMs: number, pauseMs: number,
  uses: { grams: number; perKg: number | null }[],
): Costs {
  const total = Math.max(endMs - startMs, 1);
  const pause = Math.min(pauseMs, total);
  // на паузе (смена катушки) стол и сопло греются, но слабее, чем при печати
  const watts = (cfg.power.avgWatts * (total - pause) + cfg.power.pauseWatts * pause) / total;
  const e = energyCost(startMs, endMs, watts, cfg.tariff.zones);

  const filament = uses.reduce((s, u) => s + (u.grams * (u.perKg ?? cfg.fallbackPricePerKg)) / 1000, 0);
  const extra = (cfg.amortPerHour * total) / 3.6e6;
  return {
    grams: uses.length ? uses.reduce((s, u) => s + u.grams, 0) : null,
    kwh: e.kwh, electricity: e.cost, filament, extra, total: e.cost + filament + extra,
  };
}
