/** Состояние сервиса в памяти: связь с принтером и последние ошибки (для вкладки «Состояние») */
export interface Issue { at: number; source: string; message: string; count: number }

export const status = {
  startedAt: Date.now(),
  printer: { online: false, since: Date.now(), lastMessageAt: null as number | null, state: null as string | null, subtask: null as string | null },
  issues: [] as Issue[], // новые первыми
};

export function setOnline(online: boolean) {
  if (status.printer.online !== online) status.printer.since = Date.now();
  status.printer.online = online;
}

/** Пишет в журнал и запоминает для интерфейса; одинаковые подряд ошибки склеиваются со счётчиком */
export function report(source: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${source}]`, message);
  const top = status.issues[0];
  if (top && top.source === source && top.message === message) { top.at = Date.now(); top.count++; return; }
  status.issues.unshift({ at: Date.now(), source, message, count: 1 });
  status.issues.length = Math.min(status.issues.length, 30);
}
