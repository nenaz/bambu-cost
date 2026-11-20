import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import type { Settings } from "./config";
import { report, setOnline, status } from "./status";

export interface PrinterState {
  gcode_state?: "IDLE" | "PREPARE" | "RUNNING" | "PAUSE" | "FINISH" | "FAILED" | string;
  subtask_name?: string;
  mc_percent?: number;
  mc_remaining_time?: number;
  [key: string]: unknown;
}
export interface PrinterEvents { state: [PrinterState]; online: []; offline: [] }

/** MQTT LAN-режим Bambu. A1 шлёт изменения, поэтому копим их в state. */
export class PrinterClient extends EventEmitter<PrinterEvents> {
  state: PrinterState = {};
  private client?: mqtt.MqttClient;

  constructor(private cfg: Settings["printer"]) { super(); }

  start() {
    const { ip, serial, accessCode } = this.cfg;
    if (!ip || !serial || !accessCode) {
      console.warn("[printer] не настроен: заполните IP, серийный номер и Access Code в настройках");
      return;
    }
    const reportTopic = `device/${serial}/report`;
    this.client = mqtt.connect(`mqtts://${ip}:8883`, {
      username: "bblp", password: accessCode, rejectUnauthorized: false, reconnectPeriod: 5000,
      clientId: `bambu-cost-${Math.random().toString(16).slice(2, 8)}`,
    });
    this.client.on("connect", () => {
      setOnline(true);
      this.emit("online");
      this.client!.subscribe(reportTopic);
      this.client!.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }));
    });
    this.client.on("close", () => { setOnline(false); this.emit("offline"); });
    this.client.on("error", (e) => report("mqtt", e));
    this.client.on("message", (_t, payload) => this.handleMessage(payload));
  }

  /** Разбор сообщения принтера. Ошибки обработчиков (база, диск, баг) не глотаем: они видны в интерфейсе. */
  handleMessage(payload: Buffer) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; } // битый пакет
    if (!msg.print) return;
    Object.assign(this.state, msg.print);
    status.printer.lastMessageAt = Date.now();
    status.printer.state = this.state.gcode_state ?? status.printer.state;
    status.printer.subtask = this.state.subtask_name ?? status.printer.subtask;
    try { this.emit("state", this.state); } catch (e) { report("обработка состояния принтера", e); }
  }

  stop() { this.client?.end(true); this.client = undefined; setOnline(false); }

  /** Применить новые настройки принтера без перезапуска сервиса */
  restart(cfg: Settings["printer"]) { this.stop(); this.state = {}; this.cfg = cfg; this.start(); }
}
