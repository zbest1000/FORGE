// Optional MQTT ingress. Connects to a broker declared in env and pipes
// messages into the canonical event pipeline.
//
// Env:
//   FORGE_MQTT_URL          — e.g. mqtt://localhost:1883 or wss://broker:8083/mqtt
//   FORGE_MQTT_TOPICS       — comma-separated filter list, default "forge/#"
//   FORGE_MQTT_USERNAME, FORGE_MQTT_PASSWORD — optional

import mqtt from "mqtt";
import { ingest } from "../events.js";

let _client = null;

export function startMqttBridge(logger) {
  if (!process.env.FORGE_MQTT_URL) { logger.info("MQTT bridge disabled (set FORGE_MQTT_URL to enable)"); return; }
  const url = process.env.FORGE_MQTT_URL;
  const topics = (process.env.FORGE_MQTT_TOPICS || "forge/#").split(",").map(s => s.trim()).filter(Boolean);
  const opts = {
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  };
  if (process.env.FORGE_MQTT_USERNAME) opts.username = process.env.FORGE_MQTT_USERNAME;
  if (process.env.FORGE_MQTT_PASSWORD) opts.password = process.env.FORGE_MQTT_PASSWORD;

  logger.info({ url, topics }, "MQTT bridge connecting");
  _client = mqtt.connect(url, opts);
  _client.on("connect", () => {
    logger.info("MQTT bridge connected");
    _client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) logger.error({ err }, "MQTT subscribe failed");
      else logger.info({ topics }, "MQTT subscribed");
    });
  });
  _client.on("message", (topic, payload) => {
    let body = payload.toString();
    try { body = JSON.parse(body); } catch {}
    const isAlarm = /alarm|trip|fault/i.test(topic);
    ingest({
      event_type: isAlarm ? "alarm" : "telemetry",
      severity: isAlarm ? (body?.severity || "SEV-3") : "info",
      asset_ref: body?.asset_ref || null,
      payload: body,
      dedupe_key: `mqtt:${topic}:${body?.ts || Date.now()}`,
    }, { source: topic, source_type: "mqtt" });
  });
  _client.on("error", (err) => logger.error({ err }, "MQTT error"));
  _client.on("close", () => logger.warn("MQTT closed"));
}

export function stopMqttBridge() {
  if (_client) { try { _client.end(true); } catch {} _client = null; }
}
