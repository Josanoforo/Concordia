import test from 'node:test';
import assert from 'node:assert/strict';
import { COMA_STANDIN_PROVIDER, createComaProvider, type ComaBridge, type ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { produceCandidates } from '../src/discovery/candidates.ts';
import { nameTokenComaBridge } from '../src/eval/fixture-coma.ts';

const input: ComaSchemaInput = { database: 'TPC', normalizationMode: 'text', tables: { a: { columns: ['a_x_sk'], types: { a_x_sk: 'int' } }, b: { columns: ['b_x_sk'], types: { b_x_sk: 'int' } } }, pairs: [{ source: 'a', target: 'b', allowed: [] }] };
const run = (bridge: ComaBridge) => produceCandidates({ universeId: 'U', sourceId: 'S', configFingerprint: 'f', inputHash: 'h', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', scope: { tables: ['a', 'b'], columns: [] }, tableMetadata: {} } as any, [createComaProvider({ input, bridge })]);
const raw = (provider: string, version = '9.9') => ({ schemaVersion: 1, provider, version, matches: [{ source: 'a', target: 'b', matches: [{ sourceColumn: 'a_x_sk', targetColumn: 'b_x_sk', rawScore: 0.9 }] }] }) as any;

test('the stand-in keeps its own identity in providerStates and proposals, with its version', async () => {
  const env = await run(Object.assign(() => raw(COMA_STANDIN_PROVIDER), { standInId: COMA_STANDIN_PROVIDER }));
  assert.deepEqual(env.providerStates.map(s => s.providerId), [COMA_STANDIN_PROVIDER]);
  assert.equal(env.outOfScopeProposals![0]!.providerId, COMA_STANDIN_PROVIDER); assert.equal(env.outOfScopeProposals![0]!.providerVersion, '9.9');
  const real = await run(() => raw('valentine.Coma', '1.1.0'));
  assert.deepEqual(real.providerStates.map(s => s.providerId), ['valentine.coma']); assert.equal(real.outOfScopeProposals![0]!.providerId, 'valentine.coma');
});

test('a real COMA bridge cannot claim the stand-in identity and the stand-in cannot claim COMA', async () => {
  assert.ok((await run(() => raw(COMA_STANDIN_PROVIDER))).errors.some(e => e.code === 'COMA_BRIDGE_CONTRACT_INVALID'));
  assert.ok((await run(Object.assign(() => raw('valentine.Coma', '1.1.0'), { standInId: COMA_STANDIN_PROVIDER }))).errors.some(e => e.code === 'COMA_BRIDGE_CONTRACT_INVALID'));
  assert.ok((await run(() => raw('valentine.Coma', '2.0'))).errors.some(e => e.code === 'COMA_BRIDGE_CONTRACT_INVALID'));
});

test('the eval stand-in declares fixture.coma-standin', () => {
  assert.equal((nameTokenComaBridge(input) as any).provider, COMA_STANDIN_PROVIDER);
});
