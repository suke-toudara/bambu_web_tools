import { Client as FTPClient } from "basic-ftp";
import { Readable } from "node:stream";
import type { BambuConnection } from "./types";

const FTPS_PORT = 990;

/** Uploads a file to the printer's storage via implicit-TLS FTPS. Waits for
 * the TLS session ticket before opening the data channel — with TLS 1.3 the
 * ticket can arrive after the control connection handshake, and basic-ftp's
 * data channel reuses it; without waiting, Bambu firmware rejects the
 * renegotiated session. `remotePath` must be absolute, e.g. "/cache/x.gcode". */
export async function ftpUpload(
  conn: BambuConnection,
  data: Buffer,
  remotePath: string
): Promise<void> {
  const client = new FTPClient(15_000);
  try {
    await client.access({
      host: conn.host,
      port: FTPS_PORT,
      user: "bblp",
      password: conn.accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });
    await waitForTlsSession(client);
    const absolute = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
    await client.uploadFrom(Readable.from(data), absolute);
  } finally {
    client.close();
  }
}

async function waitForTlsSession(client: FTPClient): Promise<void> {
  const socket = (client as unknown as { ftp?: { socket?: NodeJS.Socket & { getSession?: () => unknown } } }).ftp
    ?.socket;
  if (!socket || typeof socket.getSession !== "function") return;
  if (socket.getSession()) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    socket.once("session", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
