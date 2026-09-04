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

/** Waits for `promise`, but gives up (resolves anyway) if it's still
 * pending after `ms` — for a step that's merely "nice to wait for" (a QoS 1
 * PUBACK, a graceful disconnect) so it can't hang the whole request forever
 * if the printer's broker never gets around to it. A genuine rejection
 * reaching us before the timeout still propagates; one arriving after we've
 * already given up is swallowed (nothing is awaiting it any more). */
async function orGiveUpAfter(promise: Promise<void>, ms: number): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
  promise.catch(() => {});
}

/** Publishes a raw `{"print": {...}}` command to the printer's request topic
 * and waits for the printer to start acting on it before disconnecting.
 *
 * Two details matter here, both learned the hard way by other LAN-mode
 * clients (see bambuddy's bambu_mqtt.py):
 *  - QoS should be 1, not the default 0 — the printer can silently ignore a
 *    QoS 0 publish while it's busy broadcasting its own status updates. But
 *    the printer's broker isn't guaranteed to PUBACK promptly (or at all),
 *    so waiting for it is bounded (`orGiveUpAfter`) rather than potentially
 *    hanging the request forever. A transport-level publish error (as
 *    opposed to no PUBACK) still surfaces immediately.
 *  - The socket must not be force-closed right after publishing. A print
 *    command (especially `gcode_file`/`project_file`) has the printer
 *    parsing the referenced file; yanking the connection while that's
 *    still in flight has been observed to itself produce the printer-side
 *    "0500-4003 unable to parse print file" error, unrelated to the file's
 *    own validity. Wait, then close gracefully (not `end(true)`) — again
 *    bounded, so a slow/unresponsive graceful close can't hang forever. */
export async function publishPrintCommand(
  conn: BambuConnection,
  command: Record<string, unknown>
): Promise<void> {
  const client = await connectClient(conn);
  try {
    const published = new Promise<void>((resolve, reject) => {
      client.publish(
        `device/${conn.serial}/request`,
        JSON.stringify({ print: { sequence_id: "0", ...command } }),
        { qos: 1 },
        (err) => (err ? reject(err) : resolve())
      );
    });
    await orGiveUpAfter(published, 5000);
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    await orGiveUpAfter(new Promise<void>((resolve) => client.end(false, {}, () => resolve())), 5000);
  }
}
