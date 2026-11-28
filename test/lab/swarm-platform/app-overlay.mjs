// Isolated platform policy/runtime adapter evidence; no managed app registration or rollout is admitted.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSwarmAuthority } from '../../../cli/src/contracts/swarm-authority.ts';
import { appOverlayRequest, provisionAppOverlay } from '../../../cli/src/server/platform/app-overlay.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';

const [image, output] = process.argv.slice(2); assert.ok(output); assert.match(image, /^node:24\.22\.1-trixie-slim@sha256:[a-f0-9]{64}$/);
const api = dockerApi(); const calls = []; const networkSnapshots = []; const tracked = { networks: [], containers: [] };
const runtime = appOverlays({ request: async (...args) => { const reply = await api.request(...args); calls.push({ at: Date.now(), method: args[0], path: args[1], status: reply.status }); if (args[0] === "GET" && args[1].startsWith("/networks/")) { assert.ok(networkSnapshots.length < 512); networkSnapshots.push({ at: Date.now(), path: args[1], value: reply.value }); } return reply; } });
const creates = () => calls.filter((call) => call.method === 'POST').length;
try {
  const info = await api.request('GET', '/info'); assert.equal(info.status, 200); const swarm = info.value.Swarm;
  const routing = await api.request('POST', '/networks/create', { Name: 'platform-swarm', Driver: 'overlay', Scope: 'swarm', Attachable: true }); assert.equal(routing.status, 201); tracked.networks.push(routing.value.Id);
  const host = parseSwarmAuthority({ version: 1, node: swarm.NodeID, cluster: swarm.Cluster.ID, network: { name: 'platform-swarm', id: routing.value.Id },
    profile: { enabled: true, advertise_address: swarm.NodeAddr, memory_bytes: 3221225472, cpu_millicores: 2000, platform_memory_bytes: 1073741824, platform_cpu_millicores: 500 } }); assert.ok(host.ok);
  const request = (app) => { const incarnation = randomUUID(); const metadata = { version: 1, app, incarnation, actionId: `${incarnation}:1`, registrationGeneration: randomUUID() }; const checked = appOverlayRequest(metadata, 'swarm', host.value, metadata.registrationGeneration, Date.now() + 90000); assert.ok(checked.ok); return checked.value; };
  const action = request('overlay-lab'); const first = await provisionAppOverlay(action, null, runtime); assert.ok(first.ok); tracked.networks.push(first.value.id);
  assert.notEqual(first.value.id, routing.value.Id); assert.notEqual(first.value.scope.name, 'platform-swarm');
  const second = await provisionAppOverlay(action, first.value, runtime); assert.deepEqual(second, first); assert.equal(creates(), 1);
  const container = await api.request('POST', '/containers/create', { Image: image, Labels: { 'io.kayra.lab': action.scope.incarnation }, Entrypoint: ['node'], Cmd: ['--eval', 'setTimeout(()=>{},60000)'], Healthcheck: { Test: ['NONE'] },
    HostConfig: { NetworkMode: first.value.id, ReadonlyRootfs: true, Memory: 134217728, NanoCpus: 250000000, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' } } }); assert.equal(container.status, 201); tracked.containers.push(container.value.Id);
  assert.equal((await api.request('POST', `/containers/${container.value.Id}/start`)).status, 204);
  const attached = await api.request('GET', `/containers/${container.value.Id}/json`); assert.equal(attached.status, 200);
  assert.ok(Object.values(attached.value.NetworkSettings.Networks).some((network) => network.NetworkID === first.value.id));
  assert.deepEqual(await provisionAppOverlay(action, first.value, runtime), first); assert.equal(creates(), 1);
  assert.equal((await api.request('POST', `/containers/${container.value.Id}/stop?t=1`)).status, 204);
  assert.equal((await api.request('DELETE', `/containers/${container.value.Id}?force=false`)).status, 204);
  const missingAction = request('overlay-missing'); const known = await provisionAppOverlay(missingAction, null, runtime); assert.ok(known.ok); tracked.networks.push(known.value.id);
  assert.equal((await api.request('DELETE', `/networks/${known.value.id}`)).status, 204); const beforeMissing = creates();
  const missing = await provisionAppOverlay(missingAction, known.value, runtime); assert.equal(missing.ok, false); assert.match(missing.error, /missing/); assert.equal(creates(), beforeMissing);
  const foreignAction = request('overlay-conflict'); const foreign = await api.request('POST', '/networks/create', { Name: foreignAction.scope.name, Driver: 'overlay', Scope: 'swarm', Attachable: true, Labels: { 'io.kayra.lab': 'foreign-ownership-fixture' } }); assert.equal(foreign.status, 201); tracked.networks.push(foreign.value.Id);
  const beforeForeign = creates(); assert.equal((await runtime.observe(foreignAction.scope)).status, 'foreign'); assert.equal(await runtime.create(foreignAction), 'conflict'); assert.equal(creates(), beforeForeign);
  const result = { passed: true, scope: 'isolated app-overlay platform policy and runtime adapter, not registration publication or managed workload integration', first: first.value,
    secondProvisionCreatedNothing: true, privateAndRoutingNetworksDistinct: true, attachableContainerUsedExactId: true, missingStoredGrantRefusedWithoutRecreation: true, foreignOwnershipRefused: true, node: process.version };
  await writeFile(join(output, 'app-overlay.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) { await writeFile(join(output, 'app-overlay-failure.json'), JSON.stringify({ error: String(error), tracked }, null, 2)); throw error; }
finally { await writeFile(join(output, 'app-overlay-requests.json'), JSON.stringify(calls, null, 2)); await writeFile(join(output, 'app-overlay-network-snapshots.json'), JSON.stringify(networkSnapshots, null, 2)); }
