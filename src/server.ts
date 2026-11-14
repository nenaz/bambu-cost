import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { Bootstrap, Settings } from "./config";
import type { Db, JobRow } from "./db";
import { applyCosts, attachSlice } from "./jobs";
import { rankSpools, spoolStatus } from "./spools";
import { energyCost, validateZones } from "./tariff";
import { readSliceInfo, stripExt } from "./threeMf";

interface Deps { boot: Bootstrap; db: Db; getCfg: () => Settings; setCfg: (s: Settings) => void }

export function startServer({ boot, db, getCfg, setCfg }: Deps) {
  const app = express();
  const MASK = "••••";

  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  app.use(express.static("public"));
  app.get("/version", (_q, res) => res.json({ version }));
  app.use("/api", (req, res, next) => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    t === boot.token ? next() : res.status(401).json({ error: "Неверный токен" });
  });
  app.use("/api", express.json());

  const jobView = (j: JobRow) => {
    const c = getCfg();
    return { ...j, price: j.total_cost == null ? null : j.total_cost * (1 + c.markupPercent / 100) + c.markupFixed, spools: db.jobSpools(j.id) };
  };

  // --- задания (бот берёт отсюда себестоимость и рекомендуемую цену) ---
  app.get("/api/jobs", (_q, res) => res.json(db.list().map(jobView)));
  app.get("/api/jobs/:id", (q, res) => {
    const j = db.get(Number(q.params.id));
    j ? res.json(jobView(j)) : res.status(404).json({ error: "Нет такого задания" });
  });
  app.put("/api/jobs/:id", (q, res) => {
    const id = Number(q.params.id);
    if (!db.get(id)) return res.status(404).json({ error: "Нет такого задания" });
    const { order_id, spools } = q.body ?? {};
    if (order_id !== undefined) db.setOrder(id, order_id || null);
    if (spools) {
      const all = db.spools();
      for (const [slot, sid] of Object.entries(spools)) {
        const sp = all.find((s) => s.id === Number(sid));
        db.assignSpool(id, Number(slot), sp?.id ?? null, sp ? (sp.price / sp.weight_g) * 1000 : null);
      }
      applyCosts(db, getCfg(), id);
    }
    res.json(jobView(db.get(id)!));
  });
  app.post("/api/jobs/:id/refile", (q, res) => {
    const id = Number(q.params.id), j = db.get(id);
    if (!j?.ended_at) return res.status(404).json({ error: "Задание не найдено или ещё идёт" });
    if (!attachSlice(db, getCfg(), boot.slicedFilesDir, id)) {
      return res.status(404).json({ error: `Файл нарезки для «${j.name}» не найден. Загрузите его во вкладке «Проверка перед печатью» и повторите.` });
    }
    res.json(jobView(db.get(id)!));
  });
  app.delete("/api/jobs/:id", (q, res) => { db.deleteJob(Number(q.params.id)); res.json({ ok: true }); });

  // --- катушки ---
  const spoolsOut = () => db.spools().map((s) => ({ ...s, status: spoolStatus(s, getCfg().lowStockG) }));
  app.get("/api/spools", (_q, res) => res.json(spoolsOut()));
  app.post("/api/spools", (q, res) => {
    const d = q.body ?? {};
    if (!d.type || !(d.weight_g > 0) || !(d.price >= 0)) return res.status(400).json({ error: "Нужны тип, вес катушки и цена" });
    db.addSpool(d);
    res.json(spoolsOut());
  });
  app.put("/api/spools/:id", (q, res) => { db.updateSpool(Number(q.params.id), q.body ?? {}); res.json(spoolsOut()); });

  // --- настройки ---
  app.get("/api/settings", (_q, res) => {
    const c = getCfg();
    res.json({ ...c, printer: { ...c.printer, accessCode: c.printer.accessCode ? MASK : "" } });
  });
  app.put("/api/settings", (q, res) => {
    const cur = getCfg(), p = q.body ?? {};
    const next: Settings = { ...cur, ...p, printer: { ...cur.printer, ...p.printer }, power: { ...cur.power, ...p.power }, tariff: { ...cur.tariff, ...p.tariff } };
    if (!p.printer?.accessCode || p.printer.accessCode === MASK) next.printer.accessCode = cur.printer.accessCode;
    validateZones(next.tariff.zones);
    setCfg(next);
    res.json({ ok: true });
  });

  // --- проверка перед печатью: загрузка нарезки, сравнение с остатками ---
  app.post("/api/preflight", express.raw({ type: () => true, limit: "100mb" }), (q, res) => {
    const cfg = getCfg();
    const name = path.basename(decodeURIComponent(String(q.headers["x-filename"] ?? "")));
    if (!/\.3mf$/i.test(name) || !Buffer.isBuffer(q.body) || !q.body.length) return res.status(400).json({ error: "Нужен файл .gcode.3mf" });
    const info = readSliceInfo(q.body);
    fs.mkdirSync(boot.slicedFilesDir, { recursive: true });
    fs.writeFileSync(path.join(boot.slicedFilesDir, name), q.body); // дальше его найдёт трекер по имени
    const spools = db.spools(), now = Date.now();
    res.json({
      name: stripExt(name), predictionSec: info.predictionSec, low: cfg.lowStockG, safety: cfg.safetyPercent, currency: cfg.tariff.currency,
      electricity: info.predictionSec ? energyCost(now, now + info.predictionSec * 1000, cfg.power.avgWatts, cfg.tariff.zones).cost : null,
      slots: info.filaments.map((f) => {
        const same = rankSpools(f, spools);
        const list = same.length ? same : spools.filter((s) => !s.archived);
        return {
          slot: f.id, type: f.type, color: f.color, needG: f.usedG,
          candidates: list.map((s) => ({
            id: s.id, remaining: s.remaining_g,
            label: `${s.brand} ${s.type} ${s.color}`.trim() + (same.length ? "" : " (другой тип!)"),
          })),
        };
      }),
    });
  });
  // --- заказы из Telegram-бота: калькулятор только проксирует его локальный API ---
  const botCall = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(boot.botUrl + p, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Authorization: "Bearer " + boot.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { code: r.status, data: await r.json() };
  };
  const viaBot = (method: string, path: (q: express.Request) => string, body?: (q: express.Request) => unknown): express.RequestHandler =>
    async (q, res) => {
      try {
        const r = await botCall(method, path(q), body?.(q));
        res.status(r.code).json(r.data);
      } catch (e) {
        res.status(502).json({ error: "Бот недоступен: " + (e as Error).message });
      }
    };
  app.get("/api/orders", viaBot("GET", () => "/orders"));
  app.post("/api/orders/:id/status", viaBot("POST", (q) => `/orders/${Number(q.params.id)}/status`, (q) => ({ status: q.body?.status })));

  app.post("/api/plans", (q, res) => {
    if (!q.body?.name || !q.body?.spools) return res.status(400).json({ error: "Нужны name и spools" });
    db.setPlan(q.body.name, q.body.spools);
    res.json({ ok: true });
  });

  app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => res.status(400).json({ error: err.message }));
  app.listen(boot.port, "0.0.0.0", () => console.log(`Интерфейс: http://<адрес этого компьютера>:${boot.port}`));
}
