import { Agent, request } from "node:https";
import { connect } from "node:net";
import { getCACertificates } from "node:tls";
import { failure, type Network } from "./commands/status.ts";

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "ERROR";

const since = (started: number): number => Math.round(performance.now() - started);

/** The network, as status asks it: a TCP connect, an HTTPS GET, each given up after `ms`; every answer a Reach, never an exception. */
export const network = (ms: number): Network => {
  // A multipass server's certificates are mkcert's, whose root is in the system's store, not Node's.
  // Reading it takes a while: after the first frame, not before.
  const agent = new Promise<Agent>((resolve) => {
    setImmediate(() => {
      resolve(new Agent({ ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])] }));
    });
  });
  return {
    connect: (host, port) =>
      new Promise((resolve) => {
        const started = performance.now();
        const socket = connect({ host, port, timeout: ms });
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
  };
};
