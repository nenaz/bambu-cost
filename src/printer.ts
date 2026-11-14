import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import type { Settings } from "./config";

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
    const report = `device/${serial}/report`;
    this.client = mqtt.connect(`mqtts://${ip}:8883`, {
      username: "bblp", password: accessCode, rejectUnauthorized: false, reconnectPeriod: 5000,
      clientId: `bambu-cost-${Math.random().toString(16).slice(2, 8)}`,
    });
    this.client.on("connect", () => {
      this.emit("online");
      this.client!.subscribe(report);
      this.client!.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }));
    });
    this.client.on("close", () => this.emit("offline"));
    this.client.on("error", (e) => console.error("[mqtt]", e.message));
    this.client.on("message", (_t, payload) => {
      try {
        const msg = JSON.parse(payload.toString());
        if (msg.print) { Object.assign(this.state, msg.print); this.emit("state", this.state); }
      } catch { /* битый пакет */ }
    });
  }

  stop() { this.client?.end(true); this.client = undefined; }

  /** Применить новые настройки принтера без перезапуска сервиса */
  restart(cfg: Settings["printer"]) { this.stop(); this.state = {}; this.cfg = cfg; this.start(); }
}
