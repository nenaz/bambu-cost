import type { Bootstrap, Settings } from "./config";
import { applyCosts } from "./jobs";
import type { Db, JobRow } from "./db";
import type { PrinterClient, PrinterState } from "./printer";
import { pickSpool } from "./spools";
import { findSlicedFile, readSliceInfo, type SliceInfo } from "./threeMf";

const ACTIVE = new Set(["PREPARE", "RUNNING", "PAUSE"]);
const ENDED = new Set(["FINISH", "FAILED", "IDLE"]);

function loadSlice(file: string | null): SliceInfo | null {
  if (!file) return null;
  try { return readSliceInfo(file); } catch (e) { console.warn("[3mf]", (e as Error).message); return null; }
}

/** Превращает смены gcode_state в задания, считает паузы, списывает катушки */
export class JobTracker {
  private seenFirst = false;
  private lastState?: string;
  private pauseSince?: number;

  constructor(private getCfg: () => Settings, private boot: Bootstrap, private db: Db, printer: PrinterClient) {
    printer.on("state", (s) => this.onState(s));
  }

  private onState(s: PrinterState) {
    const g = s.gcode_state;
    if (!g) return;
    if (g !== this.lastState) { console.log(`[state] ${this.lastState ?? "-"} → ${g} (${s.subtask_name ?? ""})`); this.lastState = g; }

    const first = !this.seenFirst;
    this.seenFirst = true;
    const open = this.db.openJob();

    if (open) { // смена катушки руками = PAUSE: считаем время отдельно
      if (g === "PAUSE" && !this.pauseSince) this.pauseSince = Date.now();
      if (g !== "PAUSE" && this.pauseSince) { this.db.addPause(open.id, Date.now() - this.pauseSince); this.pauseSince = undefined; }
    }

    if (ACTIVE.has(g)) {
      if (!open) {
        const id = this.db.start(s.subtask_name ?? "", Date.now(), first);
        console.log(`[job ${id}] старт: ${s.subtask_name ?? "?"}${first ? " (программа запущена посреди печати)" : ""}`);
      } else if (!open.name && s.subtask_name) this.db.setName(open.id, s.subtask_name);
    } else if (open && ENDED.has(g)) {
      this.finish(open, g, s);
    }
  }

  private finish(open: JobRow, status: string, s: PrinterState) {
    const cfg = this.getCfg();
    const name = open.name || s.subtask_name || "unknown";
    const file = findSlicedFile(this.boot.slicedFilesDir, name);
    const slice = loadSlice(file);
    this.db.close(open.id, Date.now(), status, name, file);

    if (slice) {
      // брак: списываем пропорционально прогрессу (приблизительно)
      const k = status === "FAILED" && s.mc_percent ? s.mc_percent / 100 : 1;
      const plan = this.db.takePlan(name);
      const spools = this.db.spools();
      this.db.setJobSpools(open.id, slice.filaments.map((f) => {
        const sp = pickSpool(f, plan?.[f.id], spools);
        return { slot: f.id, grams: f.usedG * k, spoolId: sp?.id ?? null, perKg: sp ? (sp.price / sp.weight_g) * 1000 : null };
      }));
    } else console.warn(`[job ${open.id}] нет файла ${name}.gcode.3mf в ${this.boot.slicedFilesDir}: привяжите вручную или загрузите через интерфейс`);

    applyCosts(this.db, cfg, open.id);
    const j = this.db.get(open.id)!;
    console.log(`[job ${j.id}] ${name} (${status}): ${j.grams?.toFixed(1) ?? "?"} г, ${j.kwh?.toFixed(2)} кВт·ч, итого ${j.total_cost?.toFixed(2)} ${cfg.tariff.currency}`);
  }
}
