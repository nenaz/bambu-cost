import { DatabaseSync } from "node:sqlite";
import type { Settings } from "./config";
import type { Costs } from "./costs";

export interface JobRow {
  id: number; name: string; started_at: number; ended_at: number | null; status: string | null;
  partial: number; pause_ms: number; order_id: string | null; grams: number | null; kwh: number | null;
  electricity_cost: number | null; filament_cost: number | null; extra_cost: number | null;
  total_cost: number | null; source_file: string | null;
}
export interface Spool {
  id: number; brand: string; type: string; color: string; hex: string; weight_g: number;
  price: number; base_g: number; base_at: number; archived: number; remaining_g: number;
}
export interface JobSpool { job_id: number; slot: number; spool_id: number | null; grams: number; price_per_kg: number | null }

// Остаток катушки = последнее взвешивание минус граммы заданий, завершённых после него.
// Поэтому правка или удаление задания само пересчитывает остаток.
const SPOOLS_SQL = `SELECT s.*, s.base_g - COALESCE((SELECT SUM(js.grams) FROM job_spools js JOIN jobs j ON j.id = js.job_id
  WHERE js.spool_id = s.id AND j.ended_at > s.base_at), 0) AS remaining_g FROM spools s`;

export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
        status TEXT, partial INTEGER NOT NULL DEFAULT 0, pause_ms INTEGER NOT NULL DEFAULT 0, order_id TEXT,
        grams REAL, kwh REAL, electricity_cost REAL, filament_cost REAL, extra_cost REAL, total_cost REAL, source_file TEXT);
      CREATE TABLE IF NOT EXISTS spools (
        id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, color TEXT NOT NULL DEFAULT '',
        hex TEXT NOT NULL DEFAULT '', weight_g REAL NOT NULL, price REAL NOT NULL, base_g REAL NOT NULL, base_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS job_spools (
        job_id INTEGER NOT NULL, slot INTEGER NOT NULL, spool_id INTEGER, grams REAL NOT NULL, price_per_kg REAL,
        PRIMARY KEY (job_id, slot));
      CREATE TABLE IF NOT EXISTS plans (name TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // миграция БД из первой версии
    for (const col of ["pause_ms INTEGER NOT NULL DEFAULT 0", "order_id TEXT"]) {
      try { this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* уже есть */ }
    }
  }

  /** Проверка, что база реально пишется (диск полон, карта памяти в режиме «только чтение» и т.п.) */
  health(): { ok: boolean; error?: string } {
    try {
      this.db.prepare("INSERT INTO kv (key, value) VALUES ('health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  // --- настройки ---
  getSettings(): Partial<Settings> | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE key='settings'").get() as unknown as { value: string } | undefined;
    return r && JSON.parse(r.value);
  }
  setSettings(s: Settings) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
  }

  // --- задания ---
  openJob() { return this.db.prepare("SELECT * FROM jobs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as unknown as JobRow | undefined; }
  get(id: number) { return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined; }
  list(limit = 100) { return this.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as unknown as JobRow[]; }
  start(name: string, startedAt: number, partial: boolean) {
    return Number(this.db.prepare("INSERT INTO jobs (name, started_at, partial) VALUES (?, ?, ?)").run(name, startedAt, partial ? 1 : 0).lastInsertRowid);
  }
  setName(id: number, name: string) { this.db.prepare("UPDATE jobs SET name = ? WHERE id = ?").run(name, id); }
  addPause(id: number, ms: number) { this.db.prepare("UPDATE jobs SET pause_ms = pause_ms + ? WHERE id = ?").run(ms, id); }
  setOrder(id: number, order: string | null) { this.db.prepare("UPDATE jobs SET order_id = ? WHERE id = ?").run(order, id); }
  close(id: number, endedAt: number, status: string, name: string, file: string | null) {
    this.db.prepare("UPDATE jobs SET ended_at=?, status=?, name=?, source_file=? WHERE id=?").run(endedAt, status, name, file, id);
  }
  setSourceFile(id: number, file: string) { this.db.prepare("UPDATE jobs SET source_file = ? WHERE id = ?").run(file, id); }
  saveCosts(id: number, c: Costs) {
    this.db.prepare("UPDATE jobs SET grams=?, kwh=?, electricity_cost=?, filament_cost=?, extra_cost=?, total_cost=? WHERE id=?")
      .run(c.grams, c.kwh, c.electricity, c.filament, c.extra, c.total, id);
  }
  deleteJob(id: number) {
    this.db.prepare("DELETE FROM job_spools WHERE job_id = ?").run(id);
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  // --- расход по катушкам ---
  jobSpools(id: number) { return this.db.prepare("SELECT * FROM job_spools WHERE job_id = ? ORDER BY slot").all(id) as unknown as JobSpool[]; }
  setJobSpools(id: number, rows: { slot: number; grams: number; spoolId: number | null; perKg: number | null }[]) {
    this.db.prepare("DELETE FROM job_spools WHERE job_id = ?").run(id);
    const ins = this.db.prepare("INSERT INTO job_spools (job_id, slot, spool_id, grams, price_per_kg) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(id, r.slot, r.spoolId, r.grams, r.perKg);
  }
  assignSpool(id: number, slot: number, spoolId: number | null, perKg: number | null) {
    this.db.prepare("UPDATE job_spools SET spool_id = ?, price_per_kg = ? WHERE job_id = ? AND slot = ?").run(spoolId, perKg, id, slot);
  }

  // --- катушки ---
  spools() { return this.db.prepare(`${SPOOLS_SQL} ORDER BY s.archived, s.type, s.id`).all() as unknown as Spool[]; }
  addSpool(d: { brand?: string; type: string; color?: string; hex?: string; weight_g: number; price: number; remaining_g?: number }) {
    return Number(this.db.prepare("INSERT INTO spools (brand, type, color, hex, weight_g, price, base_g, base_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(d.brand ?? "", d.type, d.color ?? "", d.hex ?? "", d.weight_g, d.price, d.remaining_g ?? d.weight_g, Date.now()).lastInsertRowid);
  }
  updateSpool(id: number, p: Record<string, unknown>) {
    for (const k of ["brand", "type", "color", "hex", "weight_g", "price", "archived"]) {
      if (p[k] !== undefined) this.db.prepare(`UPDATE spools SET ${k} = ? WHERE id = ?`).run(p[k] as string | number, id);
    }
    if (p.remaining_g !== undefined) { // корректировка по взвешиванию
      this.db.prepare("UPDATE spools SET base_g = ?, base_at = ? WHERE id = ?").run(Number(p.remaining_g), Date.now(), id);
    }
  }

  // --- выбор катушек перед печатью ---
  setPlan(name: string, spools: Record<string, number>) {
    this.db.prepare("INSERT INTO plans (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data").run(name, JSON.stringify(spools));
  }
  takePlan(name: string): Record<string, number> | undefined {
    const r = this.db.prepare("SELECT data FROM plans WHERE name = ?").get(name) as unknown as { data: string } | undefined;
    this.db.prepare("DELETE FROM plans WHERE name = ?").run(name);
    return r && JSON.parse(r.data);
  }
}
