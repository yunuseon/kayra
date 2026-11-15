/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- owns daemon replies, mutable caller inputs and transport faults */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseContainerCheckPlan } from "../../src/contracts/container-check.ts";
import { managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import { containerChecks } from "../../src/server/runtime/container-check.ts";
import { dockerApi } from "../../src/server/runtime/docker-api.ts";

const fixture = () => {
  const incarnation = randomUUID(); const action = { app: "shop", incarnation, dataOwner: randomUUID(), service: "worker", action: incarnation + ":2", effect: "apply" as const, plan: "a".repeat(64), deadline: 91000 };
  const target = { action, service: "s".repeat(25), task: "t".repeat(25), container: "c".repeat(64) };
  const checked = parseContainerCheckPlan({ version: 1, application: "b".repeat(64), run: randomUUID(), check: "confirm", target, command: ["node", "/check.js"], deadline: 91000, timeoutSeconds: 30 }); assert.ok(checked.ok); const plan = checked.value;
  const labels = { "com.kayra.app": action.app, "com.kayra.incarnation": action.incarnation, "com.kayra.data-owner": action.dataOwner, "com.kayra.service": action.service, "com.kayra.action": action.action, "com.kayra.plan": action.plan, "com.kayra.effect": action.effect };
  const service = { ID: target.service, Version: { Index: 42 }, Spec: { Name: managedServiceName(action, action.service), Labels: labels, Mode: { Replicated: { Replicas: 1 } }, TaskTemplate: { ContainerSpec: { Labels: labels } } }, UpdateStatus: { State: "completed" } };
  const task = { ID: target.task, ServiceID: target.service, DesiredState: "running", Spec: { ContainerSpec: { Labels: labels } }, Status: { State: "running", ContainerStatus: { ContainerID: target.container } } };
  const container = { Id: target.container, Config: { Env: ["TOKEN=PRIVATE-TOKEN"], Labels: { ...labels, "com.docker.swarm.service.id": target.service, "com.docker.swarm.task.id": target.task } }, State: { Running: true, Paused: false, Restarting: false, Health: { Status: "healthy" } } };
  const exec = "e".repeat(64); const process = { ID: exec, ContainerID: target.container, Running: false, ExitCode: 0, OpenStdin: false, OpenStdout: false, OpenStderr: false, ProcessConfig: { entrypoint: "node", arguments: ["/check.js"], privileged: false, tty: false, user: "1000" } };
  let clock = 1000; let serviceReply: unknown = service; let taskReply: unknown = task; let containerReply: unknown = container; let execReply: unknown = process; let unavailable = false;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: ReturnType<typeof dockerApi> = { request: (method, path, body) => {
    calls.push({ method, path, body }); if (unavailable) throw new Error("PRIVATE_DAEMON_BODY");
    if (method === "GET") return Promise.resolve({ status: 200, value: path.startsWith("/services/") ? serviceReply : path.startsWith("/tasks/") ? taskReply : path.startsWith("/containers/") ? containerReply : execReply });
    assert.equal(method, "POST"); return Promise.resolve(path.endsWith("/exec") ? { status: 201, value: { Id: exec } } : { status: 200, value: null });
  } };
  return { action, target, plan, labels, service, task, container, process, exec, calls, api, adapter: containerChecks(api, () => clock),
    setService: (value: unknown) => { serviceReply = value; }, setTask: (value: unknown) => { taskReply = value; }, setContainer: (value: unknown) => { containerReply = value; }, setExec: (value: unknown) => { execReply = value; }, unavailable: () => { unavailable = true; }, now: (value: number) => { clock = value; } };
};

test("task selection revalidates the current native service, task, container and health without mutation", async () => {
  const f = fixture(); const selected = await f.adapter.select(f.action, { id: f.target.service, version: 41 }, f.target.task); assert.equal(selected.status, "owned"); assert.ok(f.calls.every((call) => call.method === "GET"));
  f.setTask({ ...f.task, DesiredState: "shutdown" }); assert.equal((await f.adapter.select(f.action, { id: f.target.service, version: 41 }, f.target.task)).status, "unavailable");
  f.setTask({ ...f.task, ServiceID: "x".repeat(25) }); assert.equal((await f.adapter.select(f.action, { id: f.target.service, version: 41 }, f.target.task)).status, "foreign");
});

test("check Create uses the existing admitted container with no privilege, attachment or secret expansion", async () => {
  const f = fixture(); assert.deepEqual(await f.adapter.create(f.plan), { status: "created", id: f.exec }); const writes = f.calls.filter((call) => call.method !== "GET"); assert.equal(writes.length, 1); assert.equal(writes[0]?.path, `/containers/${f.target.container}/exec`);
  assert.deepEqual(writes[0].body, { AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, Privileged: false, Cmd: f.plan.command, Env: [`KAYRA_OPERATION_ID=${f.plan.run}:check:confirm`] }); assert.equal(JSON.stringify(writes).includes("PRIVATE-TOKEN"), false);
  assert.equal(await f.adapter.start(f.plan, f.exec, 31000), "acknowledged"); const last = f.calls.at(-1); assert.equal(last?.path, `/exec/${f.exec}/start`); assert.deepEqual(last.body, { Detach: true, Tty: false });
});

test("Start rejects an exec belonging to another container, argv, privilege or attachment scope", async () => {
  const f = fixture();
  for (const reply of [{ ...f.process, ContainerID: "d".repeat(64) }, { ...f.process, ProcessConfig: { ...f.process.ProcessConfig, entrypoint: "/foreign" } }, { ...f.process, ProcessConfig: { ...f.process.ProcessConfig, privileged: true } }, { ...f.process, OpenStdout: true }]) {
    f.setExec(reply); assert.equal(await f.adapter.start(f.plan, f.exec, 31000), "refused");
  }
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
});

test("unhealthy, stopped, foreign and superseded targets cannot create or start checks", async () => {
  const f = fixture();
  for (const state of [{ ...f.container.State, Running: false }, { ...f.container.State, Paused: true }, { ...f.container.State, Health: { Status: "unhealthy" } }]) { f.setContainer({ ...f.container, State: state }); assert.equal((await f.adapter.create(f.plan)).status, "refused"); }
  f.setContainer({ ...f.container, Config: { ...f.container.Config, Labels: { ...f.container.Config.Labels, "com.kayra.data-owner": randomUUID() } } }); assert.equal((await f.adapter.create(f.plan)).status, "refused");
  f.setContainer(f.container); f.setService({ ...f.service, Spec: { ...f.service.Spec, TaskTemplate: { ContainerSpec: { Labels: { ...f.labels, "com.kayra.action": f.action.incarnation + ":3" } } } } }); assert.equal(await f.adapter.start(f.plan, f.exec, 31000), "refused");
  assert.equal(f.calls.some((call) => call.method === "POST"), false);
});

test("observation records daemon state without interpreting initial exit zero as execution proof", async () => {
  const f = fixture(); assert.deepEqual(await f.adapter.observe(f.plan, f.exec), { status: "owned", id: f.exec, running: false, exitCode: 0 });
  f.setExec({ ...f.process, Running: true }); assert.deepEqual(await f.adapter.observe(f.plan, f.exec), { status: "owned", id: f.exec, running: true, exitCode: null });
  f.setContainer({ ...f.container, State: { ...f.container.State, Running: false } }); f.setExec({ ...f.process, ExitCode: 7 }); assert.deepEqual(await f.adapter.observe(f.plan, f.exec), { status: "owned", id: f.exec, running: false, exitCode: 7 });
});

test("transport failures and expired deadlines do not expose daemon bodies or issue late Start", async () => {
  const f = fixture(); f.unavailable(); assert.deepEqual(await f.adapter.create(f.plan), { status: "uncertain" }); assert.deepEqual(await f.adapter.observe(f.plan, f.exec), { status: "unavailable" });
  const expired = fixture(); expired.now(31000); assert.equal(await expired.adapter.start(expired.plan, expired.exec, 31000), "refused"); assert.equal(expired.calls.length, 0);
  const late = fixture(); const pending = late.adapter.start(late.plan, late.exec, 31000); late.now(31000); assert.equal(await pending, "refused"); assert.equal(late.calls.some((call) => call.method === "POST"), false);
});

test("mutable caller descriptions cannot change the admitted exec after asynchronous validation", async () => {
  const f = fixture(); const plan = { ...f.plan, command: [...f.plan.command] }; const pending = f.adapter.create(plan); plan.command[0] = "/foreign";
  assert.equal((await pending).status, "created"); const write = f.calls.find((call) => call.method === "POST"); assert.ok(write); assert.deepEqual(write.body, { AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, Privileged: false, Cmd: f.plan.command, Env: [`KAYRA_OPERATION_ID=${f.plan.run}:check:confirm`] });
});
