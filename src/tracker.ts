import type { Bootstrap, Settings } from "./config";
import { applyCosts, attachSlice } from "./jobs";
import type { Db, JobRow } from "./db";
import type { PrinterClient, PrinterState } from "./printer";
import { report } from "./status";
import { stripExt } from "./threeMf";

const ACTIVE = new Set(["PREPARE", "RUNNING", "PAUSE"]);
const ENDED = new Set(["FINISH", "FAILED", "IDLE"]);

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
    this.db.close(open.id, Date.now(), status, name, null);
    // брак: списываем пропорционально прогрессу (приблизительно)
    const k = status === "FAILED" && s.mc_percent ? s.mc_percent / 100 : 1;
    const plan = this.db.takePlan(stripExt(name));
    if (!attachSlice(this.db, cfg, this.boot.slicedFilesDir, open.id, plan, k)) {
      report("файл нарезки", `нет файла для «${name}» (задание #${open.id}): загрузите его в «Проверке перед печатью» и нажмите «Найти файл» в истории`);
      console.warn(`[job ${open.id}] нет файла нарезки для «${name}» в ${this.boot.slicedFilesDir}: загрузите его в «Проверке перед печатью» и нажмите «Найти файл» в истории`);
      applyCosts(this.db, cfg, open.id);
    }
    const j = this.db.get(open.id)!;
    console.log(`[job ${j.id}] ${name} (${status}): ${j.grams?.toFixed(1) ?? "?"} г, ${j.kwh?.toFixed(2)} кВт·ч, итого ${j.total_cost?.toFixed(2)} ${cfg.tariff.currency}`);
  }
}
