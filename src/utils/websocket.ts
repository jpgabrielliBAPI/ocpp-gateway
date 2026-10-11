import { isUtf8 } from "node:buffer";
import WebSocket from "ws";

export function forwardPing(ws: WebSocket | null, data: Buffer): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  try {
    ws.ping(data);
  } catch {
    /* best-effort — peer may have just closed */
  }
}

export function forwardPong(ws: WebSocket | null, data: Buffer): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  try {
    ws.pong(data);
  } catch {
    /* best-effort — peer may have just closed */
  }
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export function rawDataToString(data: WebSocket.RawData): string {
  return rawDataToBuffer(data).toString();
}

/** Whether the bytes are valid UTF-8, i.e. decode to text without replacement characters. */
export function isUtf8Data(data: WebSocket.RawData): boolean {
  return isUtf8(rawDataToBuffer(data));
}
