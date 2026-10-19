import { Agent, request } from "node:https";
import { connect } from "node:net";
import { getCACertificates } from "node:tls";
import type { Network } from "../status/ports.ts";
import type { Reach } from "../status/model.ts";
import { milliseconds } from "../fleet/brand.ts";
import { typed } from "../../lib/typed.ts";

/** Why a connection failed, by Node's error code. */
export const failure = (code: string) => {
  if (code === "ECONNREFUSED") return typed<Reach>({ kind: "refused" });
  if (code === "ETIMEDOUT") return typed<Reach>({ kind: "no-answer" });
  if (["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "EADDRNOTAVAIL"].includes(code)) return typed<Reach>({ kind: "unreachable" });
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA"].includes(code)) return typed<Reach>({ kind: "unknown-host" });
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) return typed<Reach>({ kind: "bad-certificate", code });
  return typed<Reach>({ kind: "failed", code });
};

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "ERROR";

const since = (started: number) => milliseconds(Math.round(performance.now() - started));

/** The network, as status asks it: a TCP connect, an HTTPS GET, each given up after `ms`; every answer a Reach, never an exception. */
export const network = (ms: number) => {
  // A multipass server's certificates are mkcert's, whose root is in the system's store, not Node's.
  // Reading it takes a while: after the first frame, not before.
  const agent = new Promise<Agent>((resolve) => {
    setImmediate(() => {
      resolve(new Agent({ ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])] }));
    });
  });
  return typed<Network>({
    connect: (host, port) =>
      new Promise((resolve) => {
        const started = performance.now();
        const socket = connect({ host, port: Number(port), timeout: ms });
        socket.once("connect", () => {
          socket.destroy();
          resolve({ kind: "open", ms: since(started) });
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve({ kind: "no-answer" });
        });
        socket.once("error", (error) => {
          resolve(failure(codeOf(error)));
        });
      }),
    get: async (url) => {
      const via = await agent;
      return new Promise((resolve) => {
        const started = performance.now();
        const asked = request(url, { agent: via, timeout: ms }, (response) => {
          response.resume();
          resolve({ kind: "answered", status: response.statusCode ?? 0, ms: since(started) });
          asked.destroy();
        });
        asked.once("timeout", () => {
          asked.destroy();
          resolve({ kind: "no-answer" });
        });
        asked.once("error", (error) => {
          resolve(failure(codeOf(error)));
        });
        asked.end();
      });
    },
  });
};
