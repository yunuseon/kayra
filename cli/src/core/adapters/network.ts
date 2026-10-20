import { execFile } from "node:child_process";
import { Agent, request } from "node:https";
import { connect } from "node:net";
import { getCACertificates } from "node:tls";
import type { Network } from "../status/ports.ts";
import type { Reach } from "../status/model.ts";
import { milliseconds } from "../fleet/brand.ts";
import { quote } from "../plan/describe.ts";
import { sshArgv } from "../recipes/ssh.ts";
import { err, ok } from "../../lib/result.ts";
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

/**
 * The network, as status asks it: a TCP connect, an HTTPS GET, each given up
 * after `ms`, every answer a Reach, never an exception; and a file read over
 * SSH, which never asks (no password, no host key to confirm: rebuilt servers
 * come back with new ones) and is given up after three times `ms`.
 */
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
    read: (inventory, path) =>
      new Promise((resolve) => {
        const [program, ...args] = sshArgv(
          inventory,
          ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${String(Math.ceil(ms / 1000))}`, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"],
          [`cat ${quote(path)} 2>/dev/null || true`],
        );
        execFile(program, args, { timeout: ms * 3, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
          const said = stderr.trim().split("\n").at(-1) ?? "";
          if (error === null) resolve(ok(stdout));
          else resolve(err(error.killed ? "no answer" : said === "" ? `ssh exited ${String(error.code ?? "")}` : said));
        });
      }),
  });
};
