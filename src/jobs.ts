import type { Settings } from "./config";
import { computeCosts } from "./costs";
import type { Db } from "./db";

/** Пересчитывает и сохраняет себестоимость завершённого задания */
export function applyCosts(db: Db, cfg: Settings, id: number) {
  const j = db.get(id);
  if (!j?.ended_at) return;
  const uses = db.jobSpools(id).map((r) => ({ grams: r.grams, perKg: r.price_per_kg }));
  db.saveCosts(id, computeCosts(cfg, j.started_at, j.ended_at, j.pause_ms, uses));
}
