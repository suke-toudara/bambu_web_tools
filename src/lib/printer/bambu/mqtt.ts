import mqtt, { type MqttClient } from "mqtt";
import type { BambuConnection, BambuStatus } from "./types";

const MQTT_PORT = 8883;
const CONNECT_TIMEOUT_MS = 8000;

/** A fresh, increasing sequence_id per command. The well-typed `bambu-node`
 * reference client does the same instead of a constant "0"; a repeated
 * sequence_id has been reported elsewhere to make firmware treat a new
 * command as a stale replay of a previous one. */
let sequenceCounter = 0;
function nextSequenceId(): string {
  sequenceCounter += 1;
  return String(sequenceCounter);
}

/**
 * Every reference LAN-mode client that's confirmed to actually start a
 * print (bambu-printer-mcp's PrinterStore, bambu-node's BambuClient) keeps
 * ONE MQTT connection open per printer for as long as the process runs,
 * rather than connecting fresh for each command. This module used to
 * connect, publish, and then disconnect (gracefully or not) within a single
 * call — closing the connection shortly after telling the printer to parse
 * a file has been observed elsewhere to itself produce the printer-side
 * "0500-4003 unable to parse print file" error. Cache and reuse a client
 * per (host, serial, accessCode) instead, and never close it ourselves;
 * only a connection error/close event evicts it so the next call
 * reconnects. This process is expected to run as a long-lived Node server
 * (`next dev` / `next start`), not a per-request serverless function, so
 * the cache actually persists across requests.
 */
const clientCache = new Map<string, MqttClient>();

function cacheKey(conn: BambuConnection): string {
  return `${conn.host}::${conn.serial}::${conn.accessCode}`;
}

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

/** Returns the cached, still-connected client for this printer, or opens
 * (and caches) a new one. The cache entry is evicted on close/error so a
 * dead connection doesn't get handed out again. */
async function getClient(conn: BambuConnection): Promise<MqttClient> {
  const key = cacheKey(conn);
  const existing = clientCache.get(key);
  if (existing && !existing.disconnecting && !existing.disconnected) {
    return existing;
  }

  const client = await connectClient(conn);
  clientCache.set(key, client);
  const evict = () => {
    if (clientCache.get(key) === client) clientCache.delete(key);
  };
  client.once("close", evict);
  client.once("error", evict);
  return client;
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

/** Requests a full status push on the (cached, persistent) connection and
 * waits for the report. Bambu printers push status incrementally (a sparse
 * "hello" first, then a fuller report), so this merges every message
 * received within the settle window. The message listener is added and
 * removed per call so repeated calls on the shared client don't stack up
 * listeners. */
export async function getStatus(conn: BambuConnection): Promise<BambuStatus> {
  const client = await getClient(conn);
  let merged: Record<string, unknown> = {};

  const reportTopic = `device/${conn.serial}/report`;
  const requestTopic = `device/${conn.serial}/request`;

  const onMessage = (_topic: string, payload: Buffer) => {
    try {
      const parsed = JSON.parse(payload.toString());
      if (parsed?.print && typeof parsed.print === "object") {
        merged = { ...merged, ...parsed.print };
      }
    } catch {
      // ignore non-JSON / unrelated payloads
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const settleTimer = setTimeout(resolve, 2500);
      client.on("message", onMessage);
      client.subscribe(reportTopic, (err) => {
        if (err) {
          clearTimeout(settleTimer);
          reject(err);
          return;
        }
        client.publish(
          requestTopic,
          JSON.stringify({ pushing: { sequence_id: nextSequenceId(), command: "pushall" } })
        );
      });
    });
  } finally {
    client.removeListener("message", onMessage);
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
 * pending after `ms`. QoS 1's PUBACK isn't guaranteed to arrive promptly
 * (or at all) from the printer's broker, so this keeps that wait from
 * hanging a request forever. A genuine rejection reaching us before the
 * timeout still propagates; one arriving after we've given up is
 * swallowed (nothing is awaiting it any more). */
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

/** Publishes a raw `{"print": {...}}` command on the (cached, persistent)
 * connection at QoS 1 (the printer can silently ignore QoS 0 while busy
 * broadcasting its own status). Deliberately does not disconnect
 * afterward — see the module doc comment on `clientCache` for why. */
export async function publishPrintCommand(
  conn: BambuConnection,
  command: Record<string, unknown>
): Promise<void> {
  const client = await getClient(conn);
  const published = new Promise<void>((resolve, reject) => {
    client.publish(
      `device/${conn.serial}/request`,
      JSON.stringify({ print: { sequence_id: nextSequenceId(), ...command } }),
      { qos: 1 },
      (err) => (err ? reject(err) : resolve())
    );
  });
  await orGiveUpAfter(published, 5000);
}
