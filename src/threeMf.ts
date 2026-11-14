import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

export interface FilamentUse { id: number; type: string; color: string; usedG: number; usedM: number }
export interface SliceInfo { predictionSec: number | null; filaments: FilamentUse[]; file: string }

/** Читает Metadata/slice_info.config из *.gcode.3mf (первая пластина) */
export function readSliceInfo(src: string | Buffer): SliceInfo {
  const entry = new AdmZip(src).getEntry("Metadata/slice_info.config");
  if (!entry) throw new Error(`В файле нет Metadata/slice_info.config (нужен файл «нарезанной» пластины)`);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => ["plate", "filament", "metadata"].includes(name),
  });
  const doc = parser.parse(entry.getData().toString("utf8"));
  const plate = doc?.config?.plate?.[0] ?? {};

  const meta: Record<string, string> = {};
  for (const m of plate.metadata ?? []) meta[m.key] = String(m.value);

  const filaments: FilamentUse[] = (plate.filament ?? []).map((f: any) => ({
    id: Number(f.id),
    type: String(f.type ?? ""),
    color: String(f.color ?? ""),
    usedG: Number(f.used_g ?? 0),
    usedM: Number(f.used_m ?? 0),
  }));

  return { predictionSec: meta.prediction ? Number(meta.prediction) : null, filaments, file: typeof src === "string" ? src : "" };
}

export const stripExt = (n: string) => n.replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, "");

/** Ищет в папке файл по имени задания (subtask_name). Если несколько - берёт самый свежий. */
export function findSlicedFile(dir: string, jobName: string): string | null {
  if (!jobName || !fs.existsSync(dir)) return null;
  const want = jobName.toLowerCase();
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith(".3mf"))
    .map((n) => ({ n, full: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const exact = files.find((f) => stripExt(f.n).toLowerCase() === want);
  if (exact) return exact.full;
  const loose = files.find((f) => stripExt(f.n).toLowerCase().startsWith(want));
  return loose?.full ?? null;
}
