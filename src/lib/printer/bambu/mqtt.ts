import mqtt, { type MqttClient } from "mqtt";
import type { BambuConnection, BambuStatus } from "./types";

const MQTT_PORT = 8883;
const CONNECT_TIMEOUT_MS = 8000;

function connectClient(conn: BambuConnection): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${conn.host}:${MQTT_PORT}`, {
      username: "bblp",
      password: conn.accessCode,
      rejectUnauthorized: false, // Bambu printers present a self-signed cert on the LAN.
      reconnectPeriod: 0,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });

    const timer = setTimeout(() => {
      client.end(true);
      reject(new Error(`Timed out connecting to Bambu printer at ${conn.host}:${MQTT_PORT}`));
    }, CONNECT_TIMEOUT_MS);

    client.once("connect", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once("error", (err) => {
      clearTimeout(timer);
      client.end(true);
      reject(err);
    });
  });
}

function parseStatus(raw: Record<string, unknown>): BambuStatus {
  const g = (k: string) => raw[k];
  return {
    connected: true,
    status: (g("gcode_state") as string) || "UNKNOWN",
    temperatures: {
      nozzle: {
        actual: Number(g("nozzle_temper") ?? 0),
        target: Number(g("nozzle_target_temper") ?? 0),
      },
      bed: {
        actual: Number(g("bed_temper") ?? 0),
        target: Number(g("bed_target_temper") ?? 0),
      },
    },
    print: {
      filename: (g("subtask_name") as string) || (g("gcode_file") as string) || "",
      progressPct: Number(g("mc_percent") ?? 0),
      timeRemainingMin: Number(g("mc_remaining_time") ?? 0),
      currentLayer: Number(g("layer_num") ?? 0),
      totalLayers: Number(g("total_layer_num") ?? 0),
    },
    raw,
  };
}

/** Opens a short-lived MQTT connection, requests a full status push, waits
 * for the report, then disconnects. Bambu printers push status
 * incrementally (a sparse "hello" first, then a fuller report), so this
 * merges every message received within the settle window. */
export async function getStatus(conn: BambuConnection): Promise<BambuStatus> {
  const client = await connectClient(conn);
  let merged: Record<string, unknown> = {};

  try {
    await new Promise<void>((resolve, reject) => {
      const reportTopic = `device/${conn.serial}/report`;
      const requestTopic = `device/${conn.serial}/request`;

      const settleTimer = setTimeout(resolve, 2500);

      client.on("message", (_topic, payload) => {
        try {
          const parsed = JSON.parse(payload.toString());
          if (parsed?.print && typeof parsed.print === "object") {
            merged = { ...merged, ...parsed.print };
          }
        } catch {
          // ignore non-JSON / unrelated payloads
        }
      });

      client.subscribe(reportTopic, (err) => {
        if (err) {
          clearTimeout(settleTimer);
          reject(err);
          return;
        }
        client.publish(
          requestTopic,
          JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } })
        );
      });
    });
  } finally {
    client.end(true);
  }

  if (Object.keys(merged).length === 0) {
    return {
      connected: true,
      status: "UNKNOWN",
      temperatures: { nozzle: { actual: 0, target: 0 }, bed: { actual: 0, target: 0 } },
      print: { filename: "", progressPct: 0, timeRemainingMin: 0, currentLayer: 0, totalLayers: 0 },
      error: "Connected, but no status report was received in time.",
    };
  }

  return parseStatus(merged);
}

/** Publishes a raw `{"print": {...}}` command to the printer's request topic
 * and waits briefly for it to be flushed before disconnecting. */
export async function publishPrintCommand(
  conn: BambuConnection,
  command: Record<string, unknown>
): Promise<void> {
  const client = await connectClient(conn);
  try {
    await new Promise<void>((resolve, reject) => {
      client.publish(
        `device/${conn.serial}/request`,
        JSON.stringify({ print: { sequence_id: "0", ...command } }),
        (err) => (err ? reject(err) : resolve())
      );
    });
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    client.end(true);
  }
}
