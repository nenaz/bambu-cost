import fs from "node:fs";

export interface Zone { name: string; from: string; to: string; price: number }

/** Минимум в config.json: то, без чего сервис не стартует */
export interface Bootstrap { dbPath: string; port: number; token: string; slicedFilesDir: string; botUrl: string; printerIp?: string }

/** Всё остальное живёт в БД и правится из интерфейса */
export interface Settings {
  printer: { ip: string; serial: string; accessCode: string };
  power: { avgWatts: number; pauseWatts: number };
  tariff: { currency: string; zones: Zone[] };
  amortPerHour: number;
  markupPercent: number;
  markupFixed: number;
  lowStockG: number;
  safetyPercent: number;
  fallbackPricePerKg: number;
}

export const DEFAULTS: Settings = {
  printer: { ip: "", serial: "", accessCode: "" },
  power: { avgWatts: 110, pauseWatts: 40 },
  tariff: { currency: "₽", zones: [{ name: "день", from: "00:00", to: "24:00", price: 5 }] },
  amortPerHour: 3,
  markupPercent: 30,
  markupFixed: 0,
  lowStockG: 100,
  safetyPercent: 10,
  fallbackPricePerKg: 1500,
};

export function loadRaw(path = "config.json"): any {
  if (!fs.existsSync(path)) throw new Error(`Нет ${path}. Скопируйте config.example.json в config.json.`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export function loadBootstrap(raw: any): Bootstrap {
  if (!raw.token) throw new Error("В config.json задайте непустой token: это пароль для интерфейса и бота");
  return { printerIp: raw.printer?.ip, dbPath: raw.dbPath ?? "./prints.db", port: raw.port ?? 8080, token: raw.token, slicedFilesDir: raw.slicedFilesDir ?? "./sliced", botUrl: String(raw.botUrl ?? "http://127.0.0.1:8081").replace(/\/$/, "") };
}

/** Первый запуск: подхватываем принтер и тариф из config.json (в том числе из старой версии) */
export function seedSettings(raw: any): Settings {
  return {
    ...DEFAULTS,
    printer: { ...DEFAULTS.printer, ...raw.printer },
    power: { ...DEFAULTS.power, ...raw.power },
    tariff: { ...DEFAULTS.tariff, ...raw.tariff },
    amortPerHour: raw.extraPerHour ?? DEFAULTS.amortPerHour,
    fallbackPricePerKg: raw.filament?.defaultPricePerKg ?? DEFAULTS.fallbackPricePerKg,
  };
}
