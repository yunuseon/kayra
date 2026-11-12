/* eslint-disable functional/no-let -- owns bounded transport buffers */
import { request } from "node:http";

const maximumBytes = 4 * 1024 * 1024;
export type DockerReply = { readonly status: number; readonly value: unknown };

/** Internal adapter transport. It never retries and never includes response bodies in errors. */
export const dockerApi = (socketPath = "/var/run/docker.sock") => Object.freeze({
  request: async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown, options: {
    readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly response?: "json" | "bytes"; readonly maximumBytes?: number;
  } = {}) => {
    if (!path.startsWith("/") || /[\r\n\0]/.test(path)) throw new Error("invalid Docker API path");
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw new Error("invalid Docker API request timeout");
    const responseLimit = options.maximumBytes ?? maximumBytes;
    if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > maximumBytes) throw new Error("invalid Docker API response limit");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && Buffer.byteLength(payload, "utf8") > maximumBytes) throw new Error("Docker API request exceeds transport limit");
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal === undefined ? [] : [options.signal])]);
    return new Promise<DockerReply>((resolve, reject) => {
      const unavailable = () => { reject(new Error("Docker API request interrupted or unavailable")); };
      const operation = request({ socketPath, method, path, signal, agent: false,
        headers: payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload, "utf8") },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > responseLimit) {
            operation.destroy();
            reject(new Error("Docker API response exceeds transport limit"));
            return;
          }
          // eslint-disable-next-line functional/immutable-data -- private bounded response buffer
          chunks.push(chunk);
        });
        response.on("error", unavailable);
        response.on("end", () => {
          try {
            const buffer = Buffer.concat(chunks, bytes);
            if (options.response === "bytes") { resolve(Object.freeze({ status: response.statusCode ?? 0, value: buffer })); return; }
            const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
            const value: unknown = content === "" ? null : JSON.parse(content);
            resolve(Object.freeze({ status: response.statusCode ?? 0, value }));
          } catch {
            reject(new Error("Docker API returned invalid JSON"));
          }
        });
      });
      operation.on("error", unavailable);
      operation.end(payload);
    });
  },
});
