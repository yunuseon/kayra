import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Result } from '../../src/lib/result.ts';
import { parseLifecycleEnvelope } from '../../src/server/deployment/lifecycle-envelope.ts';
import { beginRegistration, lifecycleActionId, requestLifecycleRemoval } from '../../src/server/deployment/lifecycle-fence.ts';
import { admitTicket, initialTicketState, reserveTicket } from '../../src/server/deployment/lifecycle-tickets.ts';

const must = <T>(result: Result<T, string>): T => { if (!result.ok) throw new Error(result.error); return result.value; };
const incarnation = '11111111-1111-4111-8111-111111111111';
const registrationGeneration = '22222222-2222-4222-8222-222222222222';
const ownershipGeneration = '33333333-3333-4333-8333-333333333333';
const registration = { kind: 'register', registrationGeneration } as const;
const removal = { kind: 'remove', ownershipGeneration } as const;

const whileRegistering = () => {
  const fence = must(requestLifecycleRemoval(must(beginRegistration('shop', incarnation))));
  const first = must(reserveTicket(must(initialTicketState('shop', incarnation))));
  const registered = must(admitTicket(first.state, first.ticket, registration));
  const second = must(reserveTicket(registered.state));
  const removing = must(admitTicket(second.state, second.ticket, removal));
  const registrationOperation = { ticket: first.ticket, action: lifecycleActionId(fence, 1), descriptor: registration };
  const removalOperation = { ticket: second.ticket, action: lifecycleActionId(fence, 2), descriptor: removal };
  return { version: 1 as const, created: true, fence, tickets: removing.state, operations: [registrationOperation, removalOperation], registrationOperation, removalOperation };
};

test('a removal requested during registration binds both independent actions and tickets', () => {
  const { registrationOperation, removalOperation, ...envelope } = whileRegistering();
  assert.equal(parseLifecycleEnvelope(envelope).ok, true);
  assert.equal(parseLifecycleEnvelope({ ...envelope, operations: [
    { ...registrationOperation, ticket: removalOperation.ticket },
    { ...removalOperation, ticket: registrationOperation.ticket },
  ] }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...envelope, operations: [
    { ...registrationOperation, action: removalOperation.action },
    { ...removalOperation, action: registrationOperation.action },
  ] }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...envelope, operations: [
    registrationOperation,
    { ...removalOperation, descriptor: { ...removal, ownershipGeneration: registrationGeneration } },
  ] }).ok, false);
});

test('unaccepted reservations do not disguise a missing accepted operation', () => {
  const { registrationOperation, removalOperation, ...envelope } = whileRegistering();
  const reserved = must(reserveTicket(envelope.tickets));
  assert.equal(parseLifecycleEnvelope({ ...envelope, tickets: reserved.state }).ok, true);
  assert.equal(parseLifecycleEnvelope({ ...envelope, tickets: reserved.state, operations: [{ ...removalOperation, ticket: registrationOperation.ticket }] }).ok, false);
});
