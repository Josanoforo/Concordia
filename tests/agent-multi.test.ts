import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crossConfig, runMultiAgent, runMultiAgentCommand } from '../src/agent/multi-run.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { resolveUniverseManifest, universeManifests, validateCrossConfig } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { ROOT, setTraceRun } from '../src/runtime.ts';
import { removePath } from './helpers/safe-rm.ts';

/** R5-1: one run over several universes, cross relations probed by reading each side with its own client. */
const logs: Record<string, string[]> = {};
function clientsFor(aliases: string[]) {
  const clients: Record<string, any> = {}, dataOrigins: Record<string, 'SYNTHETIC'> = {};
  for (const alias of aliases) { logs[alias] = []; clients[alias] = fixtureClient(universeConfig(alias), agentFixtures().find(item => item.alias === alias)!.tables, logs[alias]); dataOrigins[alias] = 'SYNTHETIC'; }
  return { clients, dataOrigins };
}
const resolver = (alias: string) => { const manifest = resolveUniverseManifest(alias); return manifest ? { manifest, config: universeConfig(alias) } : undefined; };
const shipped = () => crossConfig('agentfx-agentlocal-customers');
/** A TEST-ONLY declaration of a reviewed shared space: it proves the mechanism, it is not a human review of anything. */
const reviewedVariant = () => { const cross = structuredClone(shipped()); Object.assign(cross.relations[0], { kind: 'FOREIGN_KEY', reviewState: 'REVIEWED', identifierSpace: 'test-only-customer-space', sharedNamespace: 'test-only-customer-namespace',
  normalizationVersion: 'text-exact-v1', normalizationLossless: true, normalizationAdapterCapability: 'exact-text', reviewAuthorization: { approver: 'test-only', approvedAt: '2026-10-26', quote: 'synthetic test declaration, not a human review' } }); return cross; };

test('the shipped cross configs validate against the allowlists of the universes they name', () => {
  for (const id of ['agentfx-agentlocal-customers', 'u1-u2-key-equality-control']) assert.equal(crossConfig(id).id, id);
  assert.throws(() => crossConfig('../etc'), /CROSS_ID_INVALID/);
  assert.throws(() => crossConfig('does-not-exist'));
});

test('the registry rejects cross declarations that widen an allowlist, repeat ids, skip the review authorization or name a universe outside the loop', () => {
  const known = new Set(universeManifests.flatMap(manifest => manifest.relationIds.map(id => id.toLowerCase())));
  const issues = (mutate: (cross: any) => void, base: any = shipped()) => { const cross = structuredClone(base); mutate(cross); return validateCrossConfig(cross, resolver, known).map(issue => issue.code); };
  assert.deepEqual(issues(() => {}), []);
  assert.ok(issues(cross => { cross.relations[0].from.table = 'regions'; }).includes('CROSS_ENDPOINT_OUTSIDE_ALLOWLIST'), 'a table of the other universe is not in the side allowlist');
  assert.ok(issues(cross => { cross.relations[0].to.column = 'customer_name_secret'; }).includes('CROSS_ENDPOINT_OUTSIDE_ALLOWLIST'));
  assert.ok(issues(cross => { cross.universes = ['AGENTLOCAL', 'GTFS']; }).includes('CROSS_UNIVERSE_LACKS_AGENT_EXPLORATION'));
  assert.ok(issues(cross => { cross.universes = ['AGENTLOCAL', 'NOPE']; }).includes('CROSS_UNIVERSE_UNKNOWN'));
  assert.ok(issues(cross => { cross.relations[0].to.universe = 'AGENTLOCAL'; }).includes('CROSS_RELATION_NOT_CROSS_UNIVERSE'));
  assert.ok(issues(cross => { cross.relations[0].from.universe = 'U1'; }).includes('CROSS_ENDPOINT_UNIVERSE_NOT_LISTED'));
  assert.ok(issues(cross => { cross.relations[0].id = 'orders_customer'; }).includes('INVALID_OR_DUPLICATE_CROSS_RELATION_ID'), 'a cross id cannot collide with a universe relation id');
  assert.ok(issues(cross => { cross.probeLimit = 51; }).includes('CROSS_PROBE_LIMIT_INVALID'));
  assert.ok(issues(cross => { cross.relations[0].normalization = 'integer'; }).includes('NORMALIZATION_NOT_IN_CONFIG'));
  assert.ok(issues(cross => { cross.universes = ['AGENTLOCAL']; }).includes('INVALID_CROSS_UNIVERSES'));
  const reviewed = reviewedVariant();
  assert.deepEqual(validateCrossConfig(reviewed, resolver).map(issue => issue.code), []);
  assert.ok(issues(cross => { delete cross.relations[0].reviewAuthorization; }, reviewed).includes('CROSS_REVIEW_WITHOUT_AUTHORIZATION'), 'REVIEWED needs its authorization');
  assert.ok(issues(cross => { delete cross.relations[0].sharedNamespace; }, reviewed).includes('CROSS_REVIEW_REQUIRES_KIND_SPACE_AND_NAMESPACE'));
});

test('offline: each side is read with its own client and budget, no SQL spans two sources, and the unreviewed shipped declaration is INDETERMINADA', async () => {
  const { clients, dataOrigins } = clientsFor(['AGENTLOCAL', 'AGENTFX']);
  const report = await runMultiAgent('agentfx-agentlocal-customers', 'agent-multi-offline-1', { clients, dataOrigins, executionMode: 'LOCAL', persist: false });
  assert.equal(report.status, 'COMPLETED'); assert.equal(report.kind, 'MULTI_UNIVERSE_RUN');
  assert.deepEqual(report.decisions.map((d: any) => d.verdict), ['INDETERMINADA']);
  assert.notDeepEqual(report.decisions[0].reasonCodes, []);
  const localDb = universeConfig('AGENTLOCAL').tables.orders.db, fxDb = universeConfig('AGENTFX').tables.customers.db;
  assert.ok(logs.AGENTLOCAL.length > 0 && logs.AGENTFX.length > 0);
  for (const sql of logs.AGENTLOCAL) assert.ok(!sql.includes(fxDb) && !/\bcustomers\b.*\bregions\b/.test(sql), 'the AGENTLOCAL client only sees AGENTLOCAL tables');
  for (const sql of logs.AGENTFX) assert.ok(!sql.includes(localDb), 'the AGENTFX client only sees AGENTFX tables');
  for (const sql of [...logs.AGENTLOCAL, ...logs.AGENTFX]) assert.ok(/^SELECT /.test(sql) && /LIMIT \d+/.test(sql) && !/\bJOIN\b/i.test(sql));
  const [local, fx] = report.sides;
  assert.deepEqual([local.universe, fx.universe], ['AGENTLOCAL', 'AGENTFX']);
  assert.ok(local.budget.used.queries > 0 && fx.budget.used.queries > 0, 'each universe spends its own budget');
  assert.equal(local.budget.used.queries + fx.budget.used.queries, logs.AGENTLOCAL.length + logs.AGENTFX.length, 'every statement is charged to the budget of its own side');
  const provenance = report.crossRelations[0].provenance;
  assert.deepEqual([provenance.from.universe, provenance.to.universe], ['AGENTLOCAL', 'AGENTFX']);
  assert.ok(provenance.from.requestId && provenance.to.requestId && provenance.from.dataOrigin === 'SYNTHETIC' && provenance.to.executionMode === 'LOCAL');
});

test('same policy: only a human-reviewed shared identifier space lets the cross relation reach SOSTENIDA; the same keys without it do not', async () => {
  const run = async (cross: object, id: string) => { const { clients, dataOrigins } = clientsFor(['AGENTLOCAL', 'AGENTFX']); return runMultiAgent(cross, id, { clients, dataOrigins, executionMode: 'LOCAL', persist: false }); };
  const reviewed = await run(reviewedVariant(), 'agent-multi-offline-2'), unreviewed = await run(shipped(), 'agent-multi-offline-3');
  assert.deepEqual(reviewed.decisions.map((d: any) => [d.verdict, d.reasonCodes]), [['SOSTENIDA', ['bounded_sample_key_membership']]]);
  assert.equal(reviewed.crossRelations[0].overlap.matched, reviewed.crossRelations[0].overlap.probed);
  assert.equal(unreviewed.decisions[0].verdict, 'INDETERMINADA');
  const noSpace = reviewedVariant(); noSpace.relations[0].reviewState = 'PENDING'; delete noSpace.relations[0].sharedNamespace; delete noSpace.relations[0].identifierSpace;
  assert.equal((await run(noSpace, 'agent-multi-offline-4')).decisions[0].verdict, 'INDETERMINADA', 'equal keys without a shared space are never accepted');
});

test('the U1 x U2 key-equality control never reaches SOSTENIDA, whatever the numeric overlap', async () => {
  const { clients, dataOrigins } = clientsFor(['U1', 'U2']);
  const report = await runMultiAgent('u1-u2-key-equality-control', 'agent-multi-offline-5', { clients, dataOrigins, executionMode: 'LOCAL', persist: false });
  assert.ok(report.decisions.every((d: any) => d.verdict !== 'SOSTENIDA'), JSON.stringify(report.decisions));
  assert.equal(report.crossRelations[0].provenance.from.universe, 'U1'); assert.equal(report.crossRelations[0].provenance.to.universe, 'U2');
});

test('the run is persisted with provenance per side under .concordia/agent-runs/<runId>/ and refuses to overwrite', async () => {
  const runId = `agent-multi-persist-${process.pid}-${Date.now().toString(36)}`, dir = path.join(ROOT, '.concordia', 'agent-runs', runId);
  try {
    const { clients, dataOrigins } = clientsFor(['AGENTLOCAL', 'AGENTFX']);
    await runMultiAgent('agentfx-agentlocal-customers', runId, { clients, dataOrigins, executionMode: 'LOCAL' });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'multi-run.json'), 'utf8'));
    assert.deepEqual(saved.sides.map((side: any) => side.universe), ['AGENTLOCAL', 'AGENTFX']);
    for (const alias of ['AGENTLOCAL', 'AGENTFX']) assert.ok(fs.existsSync(path.join(dir, 'sides', alias, 'discovery.json')), alias);
    assert.ok(fs.existsSync(path.join(dir, 'cross-cross_agentlocal_orders_agentfx_customers.json')));
    const again = clientsFor(['AGENTLOCAL', 'AGENTFX']);
    await assert.rejects(() => runMultiAgent('agentfx-agentlocal-customers', runId, { clients: again.clients, dataOrigins: again.dataOrigins, executionMode: 'LOCAL' }), /AGENT_RUN_ALREADY_EXISTS/);
  } finally { setTraceRun(undefined); removePath(dir); } // a persisted run leaves the trace pointed at its dir: later trace() calls in this process would re-create it
});

test('the live command refuses before any network when an env is missing and uses no model', async t => {
  const saved = { ...process.env }, previousFetch = globalThis.fetch;
  for (const key of ['ZETARIS_REST_URL', 'ZETARIS_API_KEY', 'ZETARIS_ORG_ID']) delete process.env[key];
  process.env.CONCORDIA_LOCAL_ENV_FILE = path.join(ROOT, '.concordia', 'does-not-exist.env');
  globalThis.fetch = (async () => { throw new Error('network is forbidden in this test'); }) as typeof fetch;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); globalThis.fetch = previousFetch; });
  await assert.rejects(() => runMultiAgentCommand('u1-u2-key-equality-control', { runId: 'agent-multi-live-refused-1' }));
  assert.ok(!fs.existsSync(path.join(ROOT, '.concordia', 'agent-runs', 'agent-multi-live-refused-1')));
});

/** A32: the run status carries the status of its sides, with the engine's rule. */
const chooserOf = (calls: { decisionStatus: string; selected?: string; error?: object; requestedModel?: string }[]) => {
  const queue = [...calls];
  return { async choose(stage: string) { const next = queue.shift() ?? { decisionStatus: 'VALID', selected: 'STOP_EXPLORATION' };
    return { stage, status: 'PASS', requestedModel: next.requestedModel ?? 'scripted', reason: 'test', promptHash: 'x', utc: '2026-10-26T00:00:00.000Z', ...next }; } } as any;
};
const runWith = (choosers: Record<string, any>, over: { clients?: Record<string, any> } = {}) => {
  const { clients, dataOrigins } = clientsFor(['AGENTLOCAL', 'AGENTFX']);
  return runMultiAgent('agentfx-agentlocal-customers', 'agent-multi-status-' + Math.random().toString(36).slice(2, 8), { clients: { ...clients, ...over.clients }, dataOrigins, executionMode: 'LOCAL', persist: false, choosers });
};

test('A32 a side whose chooser never made a valid decision makes the run DEGRADED_NO_MODEL and the report names the side', async () => {
  const report = await runWith({ AGENTFX: chooserOf([{ decisionStatus: 'INVALID_RESPONSE', error: { code: 'MODEL_RESPONSE_INVALID' } }]) });
  const fx = report.sides.find((side: any) => side.universe === 'AGENTFX'), local = report.sides.find((side: any) => side.universe === 'AGENTLOCAL');
  assert.deepEqual([fx.status, fx.modelParticipation, local.status, local.modelParticipation], ['DEGRADED_NO_MODEL', 'FAILED', 'COMPLETED', 'NOT_REQUESTED']);
  assert.equal(report.status, 'DEGRADED_NO_MODEL'); assert.deepEqual(report.degradedSides, [{ universe: 'AGENTFX', status: 'DEGRADED_NO_MODEL' }]);
  assert.ok(report.decisions.length > 0, 'the cross relations were still decided by the policy');
});

test('A32 a side that decided once and then hit a planner error is DEGRADED; valid choosers on every side keep the run COMPLETED', async () => {
  const degraded = await runWith({ AGENTFX: chooserOf([{ decisionStatus: 'VALID', selected: 'READ_CUSTOMER_PROFILE' }, { decisionStatus: 'INVALID_RESPONSE', error: { code: 'MODEL_RESPONSE_INVALID' } }]) });
  assert.deepEqual([degraded.sides.find((side: any) => side.universe === 'AGENTFX').status, degraded.status], ['DEGRADED', 'DEGRADED']);
  const fine = await runWith({ AGENTFX: chooserOf([{ decisionStatus: 'VALID', selected: 'READ_CUSTOMER_PROFILE' }]), AGENTLOCAL: chooserOf([{ decisionStatus: 'VALID', selected: 'READ_CUSTOMER_PROFILE' }]) });
  assert.deepEqual([fine.status, fine.sides.map((side: any) => side.status), fine.degradedSides], ['COMPLETED', ['COMPLETED', 'COMPLETED'], []]);
  const none = await runWith({});
  assert.equal(none.status, 'COMPLETED', 'no chooser asked for means nothing degraded');
});

test('A32 a side whose discovery fails makes the run PARTIAL, outranking a degraded side', async () => {
  const broken = { describe: async () => { throw new Error('SIDE_DOWN'); }, runSql: async () => { throw new Error('SIDE_DOWN'); } };
  const report = await runWith({ AGENTFX: chooserOf([{ decisionStatus: 'INVALID_RESPONSE', error: { code: 'X' } }]) }, { clients: { AGENTLOCAL: broken } });
  assert.equal(report.sides.find((side: any) => side.universe === 'AGENTLOCAL').status, 'DISCOVERY_FAILED');
  assert.equal(report.status, 'PARTIAL');
});
