import type { Settings } from "./config";
import { computeCosts } from "./costs";
import type { Db } from "./db";
import { pickSpool } from "./spools";
import { findSlicedFile, readSliceInfo } from "./threeMf";

/** Пересчитывает и сохраняет себестоимость завершённого задания */
export function applyCosts(db: Db, cfg: Settings, id: number) {
  const j = db.get(id);
  if (!j?.ended_at) return;
  const uses = db.jobSpools(id).map((r) => ({ grams: r.grams, perKg: r.price_per_kg }));
  db.saveCosts(id, computeCosts(cfg, j.started_at, j.ended_at, j.pause_ms, uses));
}

/** Ищет файл нарезки по имени задания, раскладывает граммы по катушкам и пересчитывает стоимость.
 *  Возвращает путь к файлу или null, если файла нет. scale < 1 для брака (доля выполненного). */
export function attachSlice(db: Db, cfg: Settings, dir: string, id: number, plan?: Record<string, number>, scale = 1): string | null {
  const j = db.get(id);
  const file = j && findSlicedFile(dir, j.name);
  if (!file) return null;
  let slice;
  try { slice = readSliceInfo(file); } catch (e) { console.warn("[3mf]", (e as Error).message); return null; }
  const spools = db.spools();
  db.setJobSpools(id, slice.filaments.map((f) => {
    const sp = pickSpool(f, plan?.[f.id], spools);
    return { slot: f.id, grams: f.usedG * scale, spoolId: sp?.id ?? null, perKg: sp ? (sp.price / sp.weight_g) * 1000 : null };
  }));
  db.setSourceFile(id, file);
  applyCosts(db, cfg, id);
  return file;
}
