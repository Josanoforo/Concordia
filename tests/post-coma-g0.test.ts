import test from 'node:test';
import assert from 'node:assert/strict';
import { COMA_FAILED, comaFailureOf, runPostComa } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';
import { createComaProvider, type ComaBridge, type ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { produceCandidates } from '../src/discovery/candidates.ts';

const col = (name: string) => ({ name, type: 'string' });
const tables: Record<string, { cols: string[]; labels: string[]; rows: string[][] }> = {
  a: { cols: ['k', 'name'], labels: ['name'], rows: [['1', 'Downtown'], ['2', 'Harbor'], ['3', 'Airport']] },
  b: { cols: ['k', 'name'], labels: ['name'], rows: [['1', 'North Depot'], ['2', 'South Depot'], ['3', 'East Depot']] }
};
const cfg: any = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { db: 'TPC', physicalTable: n, columns: t.cols.map(col), keyColumns: [], labels: t.labels, role: 'table' }])) };
const discovery = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { columns: t.cols, sample: { rows: t.rows } }])) };
const proposal = { providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'TPC', table: 'a', column: 'k' }, to: { db: 'TPC', table: 'b', column: 'k' }, rawScore: 0.9, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] };
const client: any = { async runSql(sql: string, limit = 50) {
  const t = tables.b, rows = t.rows.slice(0, limit).map(r => sql.includes('name') ? [r[0], r[1]] : [r[0]]);
  return { sql, rows, requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
} };
const go = (thresholds?: any) => { const budget = new RunBudget(limitsFromBounds({})); return runPostComa({ cfg, catalog: { postComa: { maxProbes: 2 } } as any, discovery, proposals: [proposal], client: budgetedClient(client, budget) as any, budget, ...(thresholds ? { thresholds } : {}) }); };

test('G0-3: missing sustained thresholds is an error, never a permissive default', async () => {
  await assert.rejects(go({}), (e: any) => e.code === 'THRESHOLDS_UNAVAILABLE');
  await assert.rejects(go({ sustainedOverlap: 0.8 }), (e: any) => e.code === 'THRESHOLDS_UNAVAILABLE');
  await assert.rejects(go({ sustainedLabelAgreement: 0.8 }), (e: any) => e.code === 'THRESHOLDS_UNAVAILABLE');
});

test('G0-3: contradicting labels are LABEL_CONFLICT with thresholds and NOT_COMPARABLE without the misleading threshold, never agree', async () => {
  const withAll = (await go({ sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 })).proposals[0]!.coverageProbe.diagnostic!;
  assert.equal(withAll.labels.signal, 'LABEL_CONFLICT');
  const partial = (await go({ sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8 })).proposals[0]!.coverageProbe.diagnostic!;
  assert.deepEqual([partial.labels.signal, partial.labels.reason], ['NOT_COMPARABLE', 'LABEL_THRESHOLD_UNAVAILABLE']);
});

const input = (allowed: any[]): ComaSchemaInput => ({ database: 'TPC', normalizationMode: 'text', tables: { a: { columns: ['k'], types: { k: 'string' } }, b: { columns: ['k'], types: { k: 'string' } } }, pairs: [{ source: 'a', target: 'b', allowed }] });
const produce = (inp: ComaSchemaInput, bridge: ComaBridge) => produceCandidates({ universeId: 'U', sourceId: 's', configFingerprint: 'f', inputHash: 'h', scope: { tables: ['a', 'b'], columns: ['k'] }, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', tableMetadata: {} },
  [createComaProvider({ input: inp, bridge })]);
const okBridge: ComaBridge = () => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: [{ source: 'a', target: 'b', matches: [{ sourceColumn: 'k', targetColumn: 'k', rawScore: 0.9 }] }] });

test('G0-4: in blind discovery the expected out-of-scope matches are not errors; configured universes keep reporting them', async () => {
  const blind = await produce(input([]), okBridge);
  assert.deepEqual([blind.errors, blind.providerStates[0]!.status, blind.outOfScopeProposals?.length], [[], 'ABSTAINED', 1]);
  assert.equal(comaFailureOf(blind), undefined);
  const configured = await produce(input([{ sourceColumn: 'x', targetColumn: 'y', caseIds: [] }]), okBridge);
  assert.ok(configured.errors.some(e => e.code === 'COMA_COLUMN_PAIR_OUT_OF_SCOPE'), 'non-blind output is unchanged');
  assert.equal(comaFailureOf(configured), undefined, 'out-of-scope issues are partial and never a failure');
});

test('G0-4: a bridge that fails yields COMA_FAILED with the errors copied, distinct from NONE', async () => {
  const down: ComaBridge = () => { throw new Error('COMA_PROCESS_FAILED'); };
  const production = await produce(input([]), down);
  assert.deepEqual(comaFailureOf(production), { code: COMA_FAILED, errors: [{ code: 'COMA_PROCESS_FAILED' }] });
  const budget = new RunBudget(limitsFromBounds({}));
  const report = await runPostComa({ cfg, discovery, proposals: [], client: client as any, budget, production });
  assert.equal(report.status, 'COMA_FAILED');
  assert.deepEqual(report.errors, [{ code: 'COMA_PROCESS_FAILED' }]);
  const none = await runPostComa({ cfg, discovery, proposals: [], client: client as any, budget, production: await produce(input([]), () => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: [] })) });
  assert.equal(none.status, 'NONE');
});

test('G1: duplicate proposals keep the higher rawScore (then id), in the provider and in post-COMA, with the database part of the identity', async () => {
  const dup = (rawScore: number, reason = 'COMA_COLUMN_PAIR_OUT_OF_SCOPE') => ({ source: 'a', target: 'b', matches: [{ sourceColumn: 'k', targetColumn: 'k', rawScore }] , reason });
  const twice: ComaBridge = () => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: [dup(0.3), dup(0.9), dup(0.5)] as any });
  const production = await produce(input([]), twice);
  assert.deepEqual(production.outOfScopeProposals!.map(p => p.rawScore), [0.9]);
  const budget = new RunBudget(limitsFromBounds({}));
  const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
  const low = { ...proposal, rawScore: 0.2 }, high = { ...proposal, rawScore: 0.95 };
  const report = await runPostComa({ cfg, catalog: { postComa: { maxProbes: 5 } } as any, discovery, proposals: [high, low], client: budgetedClient(client, budget) as any, budget, thresholds });
  assert.deepEqual(report.proposals.map(p => [p.proposalId, p.rawScore]), [['a.k__b.k', 0.95]], 'the order of arrival no longer decides');
  const other = { ...proposal, from: { ...proposal.from, db: 'OTHER' }, to: { ...proposal.to, db: 'OTHER' }, rawScore: 0.4 };
  const both = await runPostComa({ cfg, catalog: { postComa: { maxProbes: 5 } } as any, discovery, proposals: [proposal, other], client: budgetedClient(client, new RunBudget(limitsFromBounds({}))) as any, budget: new RunBudget(limitsFromBounds({})), thresholds });
  assert.deepEqual(both.proposals.map(p => p.proposalId).sort(), ['OTHER.a.k__OTHER.b.k', 'TPC.a.k__TPC.b.k'], 'same table names in two databases are two proposals, with distinguishable ids');
});
