import { DEFAULTS, loadBootstrap, loadRaw, seedSettings, type Settings } from "./config";
import { Db } from "./db";
import { PrinterClient } from "./printer";
import { startServer } from "./server";
import { report } from "./status";
import { validateZones } from "./tariff";
import { JobTracker } from "./tracker";

const raw = loadRaw();
const boot = loadBootstrap(raw);
const db = new Db(boot.dbPath);

let cfg: Settings = { ...DEFAULTS, ...(db.getSettings() ?? seedSettings(raw)) };
validateZones(cfg.tariff.zones);
db.setSettings(cfg);

const printer = new PrinterClient(cfg.printer);
new JobTracker(() => cfg, boot, db, printer);
printer.on("online", () => console.log("[printer] подключено"));
printer.on("offline", () => console.log("[printer] нет связи, переподключаюсь…"));
printer.start();

startServer({
  boot, db, getCfg: () => cfg,
  setCfg: (next) => {
    const printerChanged = JSON.stringify(next.printer) !== JSON.stringify(cfg.printer);
    cfg = next;
    db.setSettings(cfg);
    if (printerChanged) printer.restart(cfg.printer);
  },
});

process.on("unhandledRejection", (e) => report("процесс", e));
process.on("SIGINT", () => { printer.stop(); process.exit(0); });
