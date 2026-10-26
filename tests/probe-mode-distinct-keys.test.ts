import test from 'node:test';
import assert from 'node:assert/strict';
import { ZetarisProbeAdapter } from '../src/relations/adapters/zetaris.ts';
import { distinctKeysScope, executeProbe, withDistinctKeysSource } from '../src/relations/probes.ts';
import { legacyRelationContract, planLegacyProbe } from '../src/relations/legacy.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { assertReadPathSql } from '../src/clients/zetaris.ts';
import { createProfileCache } from '../src/probe/column-profile.ts';

/** fact -> dimension with many fact rows per key: the fact side of a LIMIT 50 read always reaches the cap. */
const relation: any = { id: 'sales.k__dim.k', from: { db: 'D', table: 'sales', column: 'k' }, to: { db: 'D', table: 'dim', column: 'k' }, kind: 'FOREIGN_KEY', identifierSpace: 'sk', normalizationVersion: '1', normalizationLossless: true, normalizationAdapterCapability: 'text', reviewState: 'REVIEWED' };
const tables: any = { 'D.sales': { db: 'D', physicalTable: 'sales', columns: [{ name: 'k' }] }, 'D.dim': { db: 'D', physicalTable: 'dim', columns: [{ name: 'k' }] } };
const specs: any = { sales: tables['D.sales'], dim: tables['D.dim'] };
const allowlist = { 'D.sales': ['k'], 'D.dim': ['k'] };
const policy = { policyVersion: '1.0' } as any;
const salesRows = (keys: string[], perKey: number) => keys.flatMap(k => Array.from({ length: perKey }, () => [k]));
function client(keys: string[], perKey: number, extraDistinct = 0) {
  const sqls: string[] = [];
  return { sqls, runSql: async (sql: string, limit = 50) => {
    sqls.push(sql); assertReadPathSql(sql);
    const asked = [...sql.matchAll(/'([^']+)'/g)].map(m => m[1]), cap = Number(/LIMIT (\d+)$/.exec(sql)![1]);
    const rows = sql.includes('FROM (SELECT "k" FROM "D"."sales")') || sql.includes('sales') ? (sql.includes('DISTINCT') ? [...new Set(asked.filter(k => keys.includes(k)))].map(k => [k]).concat(Array.from({ length: extraDistinct }, (_, i) => [`x${i}`])) : salesRows(asked.filter(k => keys.includes(k)), perKey)) : asked.map(k => [k]);
    return { sql, rows: rows.slice(0, cap), requestId: 'r', queryId: 'q', durationMs: 1, utc: 't' };
  } };
}
async function run(keys: string[], perKey: number, distinct: boolean, extraDistinct = 0) {
  const c = client(keys, perKey, extraDistinct), values = distinct ? keys.slice(0, 49) : keys;
  const base = planLegacyProbe(relation, 'U', '1.0', 'text', 3, allowlist, 50, {}, { 'D.sales': { column: 'k', values }, 'D.dim': { column: 'k', values } });
  const plan = distinct ? withDistinctKeysSource(base) : base;
  const execution = await executeProbe(plan, new ZetarisProbeAdapter(specs, c as any), { runId: 'r', checkedAt: '2026-10-25T00:00:00.000Z', scope: distinct ? distinctKeysScope(values.length) : 'allowlisted bounded key lookup' });
  const contract = legacyRelationContract(relation, 'U', '1.0', 'text', 3);
  // namespaces are database names and must match for a foreign key
  return { c, execution, decision: evaluateRelation(contract, [execution.bundle], policy) };
}

test('without the mode a fact side with many rows per key is truncated and INDETERMINADA', async () => {
  const { decision, execution } = await run(['1', '2', '3', '4'], 20, false);
  assert.equal(execution.bundle.observations[0].truncated, true);
  assert.deepEqual([decision.verdict, decision.reasonCodes[0]], ['INDETERMINADA', 'evidence_incomplete_or_truncated']);
});

test('distinct-keys: the source is read as DISTINCT keys, not truncated, and a REVIEWED relation with 3 or more keys is SOSTENIDA', async () => {
  const { decision, execution, c } = await run(['1', '2', '3', '4'], 20, true);
  assert.match(c.sqls[0], /^SELECT DISTINCT k FROM .* WHERE k IN \('1', '2', '3', '4'\) LIMIT 5$/);
  assert.ok(!c.sqls[1].includes('DISTINCT'), 'the target read is unchanged');
  assert.equal(execution.bundle.observations[0].truncated, false); assert.equal(execution.bundle.observations[0].measuredTuples.length, 4);
  assert.equal(execution.bundle.completeness, 'COMPLETE_FOR_SCOPE'); assert.equal((execution.bundle.scope as any).value, 'claves origen muestreadas (4); destino leído completo para esas claves');
  assert.equal(decision.verdict, 'SOSTENIDA');
  assert.ok(decision.requirementsMissing.includes('global_coverage_not_established') && decision.requirementsMissing.includes('global_uniqueness_not_established'));
});

test('distinct-keys with fewer than 3 distinct keys stays INDETERMINADA insufficient_distinct_sample_keys', async () => {
  const { decision } = await run(['1', '2'], 20, true);
  assert.deepEqual([decision.verdict, decision.reasonCodes[0]], ['INDETERMINADA', 'insufficient_distinct_sample_keys']);
});

test('a distinct read that does reach the limit is still truncated and INDETERMINADA', async () => {
  const keys = Array.from({ length: 5 }, (_, i) => String(i + 1));
  const c = client(keys, 1, 60), values = keys;
  const base = planLegacyProbe(relation, 'U', '1.0', 'text', 3, allowlist, 5, {}, { 'D.sales': { column: 'k', values: values.slice(0, 4) }, 'D.dim': { column: 'k', values: values.slice(0, 4) } });
  const execution = await executeProbe(withDistinctKeysSource(base), new ZetarisProbeAdapter(specs, c as any), { runId: 'r', checkedAt: '2026-10-25T00:00:00.000Z', scope: 's' });
  assert.equal(execution.bundle.observations[0].truncated, true);
  assert.equal(evaluateRelation(legacyRelationContract(relation, 'U', '1.0', 'text', 3), [execution.bundle], policy).reasonCodes[0], 'evidence_incomplete_or_truncated');
});

test('distinct-keys needs a single key filter strictly below the limit', () => {
  const base = planLegacyProbe(relation, 'U', '1.0', 'text', 3, allowlist, 5, {}, { 'D.sales': { column: 'k', values: ['1', '2', '3', '4', '5'] }, 'D.dim': { column: 'k', values: ['1'] } });
  assert.throws(() => withDistinctKeysSource(base), /DISTINCT_KEYS_REQUIRES_SINGLE_KEY_FILTER_BELOW_LIMIT/);
});

import { probeUniverse, universeConfig } from '../src/universe-pipeline.ts';
test('pipeline: the manifest/per-run probeMode reads only the source endpoint as DISTINCT keys; without it the SQL has no DISTINCT', async () => {
  const cfg = universeConfig('U2'), sample: Record<string, unknown[]> = { apple_revenue_facts: ['320193'], apple_submissions_raw: ['0000320193', '0111'], sic_reference: ['0111', 'technology'] };
  const tablesInv = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [name, { columns: spec.columns.map((c: any) => c.name), schema: spec.columns, sample: { rows: [spec.columns.map((_: any, i: number) => sample[name]?.[i] ?? 'fixture')] }, labels: spec.labels ?? [], keyColumns: spec.keyColumns ?? [], role: spec.role ?? 'dimension' }]));
  const go = async (probeMode?: 'distinct-keys') => {
    const sqls: string[] = [];
    const client: any = { runSql: async (sql: string) => { sqls.push(sql); return { sql, requestId: 'r', queryId: 'q', rows: [['320193']], durationMs: 1, utc: '2026-10-23T00:00:00.000Z' }; } };
    const result = await probeUniverse('U2', { inventory: { tables: tablesInv }, client, persist: false, relationIds: ['cik_text_trap'], now: () => '2026-10-23T00:02:00Z', ...(probeMode ? { probeMode, dispersedSeeds: false } : {}) });
    return { sqls, evidence: result.relations[0].evidence };
  };
  const plain = await go(), distinct = await go('distinct-keys');
  assert.ok(plain.sqls.every(sql => !sql.includes('DISTINCT')));
  assert.ok(distinct.sqls[0].startsWith('SELECT DISTINCT ') && !distinct.sqls[1].includes('DISTINCT'));
  assert.match(distinct.evidence.typedEvidence.scope.value, /^claves origen muestreadas \(\d+\); destino leído completo para esas claves$/);
  assert.equal(distinct.evidence.multiplicity.sourceMultiplicity, 'DISCOVERY_SAMPLE_NOT_MEASURED_IN_READ'); assert.equal(plain.evidence.multiplicity.sourceMultiplicity, undefined);
});

test('the probe freezes the relation reviewAuthorization with the contract; editing the config afterwards does not change it', async () => {
  const cfg = universeConfig('U2'), base = cfg.relations.find((r: any) => r.id === 'cik_text_trap');
  const sample: Record<string, unknown[]> = { apple_revenue_facts: ['320193'], apple_submissions_raw: ['0000320193', '0111'], sic_reference: ['0111', 'technology'] };
  const tablesInv = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [name, { columns: spec.columns.map((c: any) => c.name), schema: spec.columns, sample: { rows: [spec.columns.map((_: any, i: number) => sample[name]?.[i] ?? 'fixture')] }, labels: spec.labels ?? [], keyColumns: spec.keyColumns ?? [], role: spec.role ?? 'dimension' }]));
  const client: any = { runSql: async (sql: string) => ({ sql, requestId: 'r', queryId: 'q', rows: [['320193']], durationMs: 1, utc: '2026-10-23T00:00:00.000Z' }) };
  const relation: any = { ...base, reviewAuthorization: { approver: 'project-owner', approvedAt: '2026-10-25', quote: 'ok' } };
  const run = (relations: any[]) => probeUniverse('U2', { inventory: { tables: tablesInv }, client, persist: false, relations, now: () => '2026-10-23T00:02:00Z' });
  const frozen = (await run([relation])).relations[0].evidence;
  relation.reviewAuthorization.approver = 'Someone else'; relation.reviewAuthorization.quote = 'edited';
  assert.deepEqual(frozen.reviewAuthorization, { approver: 'project-owner', approvedAt: '2026-10-25', quote: 'ok' });
  assert.equal((await run([base])).relations[0].evidence.reviewAuthorization, undefined, 'no field when the relation declares none');
});

test('N10: agent probes carry containment, key rules and key contracts as evidence only; the typed decision does not read them', async () => {
  const cfg = universeConfig('U2'), sample: Record<string, unknown[]> = { apple_revenue_facts: ['320193'], apple_submissions_raw: ['0000320193', '0111'], sic_reference: ['0111', 'technology'] };
  const tablesInv = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [name, { columns: spec.columns.map((c: any) => c.name), schema: spec.columns, sample: { rows: [spec.columns.map((_: any, i: number) => sample[name]?.[i] ?? 'fixture')] }, labels: spec.labels ?? [], keyColumns: spec.keyColumns ?? [], role: spec.role ?? 'dimension' }]));
  const client: any = { runSql: async (sql: string) => ({ sql, requestId: 'r', queryId: 'q', rows: [['320193']], durationMs: 1, utc: '2026-10-23T00:00:00.000Z' }) };
  const evidence = (await probeUniverse('U2', { inventory: { tables: tablesInv }, client, persist: false, relationIds: ['cik_text_trap'], now: () => '2026-10-23T00:02:00Z' })).relations[0].evidence;
  assert.ok(evidence.containment && typeof evidence.containment.comparable === 'boolean'); assert.ok(evidence.keyRules?.inclusion && evidence.keyRules?.targetUniqueness);
  const { containment, keyRules, keyContracts, ...rest } = evidence;
  assert.ok(!JSON.stringify(rest.decision).includes('keyRules'));
});

test('P2/P3 wiring: dispersed seeds are read once per source column and a failed read falls back to the first rows, reported; full evidence is attached only when asked', async () => {
  const cfg = universeConfig('U2'), sample: Record<string, unknown[]> = { apple_revenue_facts: ['320193'], apple_submissions_raw: ['0000320193', '0111'], sic_reference: ['0111', 'technology'] };
  const tablesInv = () => Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [name, { columns: spec.columns.map((c: any) => c.name), schema: spec.columns, sample: { rows: [spec.columns.map((_: any, i: number) => sample[name]?.[i] ?? 'fixture')] }, labels: spec.labels ?? [], keyColumns: spec.keyColumns ?? [], role: spec.role ?? 'dimension' }]));
  const run = async (extra: any) => {
    const sqls: string[] = [];
    const client: any = { runSql: async (sql: string) => { sqls.push(sql); if (/COUNT|GROUP BY|ORDER BY|RAND|HASH/i.test(sql) || (extra.probeMode && extra.dispersedSeeds !== false && sqls.length === 1)) throw new Error('NOT_ANSWERED'); return { sql, requestId: 'r', queryId: 'q', rows: [['320193']], durationMs: 1, utc: '2026-10-23T00:00:00.000Z' }; } };
    const result = await probeUniverse('U2', { inventory: { tables: tablesInv() }, client, persist: false, relationIds: ['cik_text_trap'], now: () => '2026-10-23T00:02:00Z', ...extra });
    return { sqls, result, probe: result.relations[0].evidence };
  };
  const plain = await run({});
  assert.equal(plain.result.sampling, undefined); assert.equal(plain.probe.sampling, undefined); assert.equal(plain.probe.fullEvidence, undefined);
  const seeded = await run({ probeMode: 'distinct-keys' });
  assert.equal(seeded.result.sampling.estimatedQueries, 1); assert.equal(seeded.result.sampling.queries, 1);
  assert.ok(seeded.result.sampling.failures.length === 1 && seeded.probe.sampling.method === 'FIRST_ROWS', 'the failed seed read is reported and the first rows are used');
  const full = await run({ probeMode: 'distinct-keys', dispersedSeeds: false, fullEvidence: true });
  assert.equal(full.probe.fullEvidence.scope, 'GLOBAL_WHOLE_TABLE'); assert.ok(['MEASURED', 'NOT_MEASURED'].includes(full.probe.fullEvidence.coverage.status));
  assert.equal(full.result.sampling, undefined);
});

test('E1-06 wiring: a shared profileCache profiles a column once across probeUniverse calls, with identical verdicts', async () => {
  const cfg = universeConfig('U2'), sample: Record<string, unknown[]> = { apple_revenue_facts: ['320193'], apple_submissions_raw: ['0000320193', '0111'], sic_reference: ['0111', 'technology'] };
  const tablesInv = () => Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [name, { columns: spec.columns.map((c: any) => c.name), schema: spec.columns.map((c: any) => ({ ...c, type: 'string' })), sample: { rows: [spec.columns.map((_: any, i: number) => sample[name]?.[i] ?? 'fixture')] }, labels: spec.labels ?? [], keyColumns: spec.keyColumns ?? [], role: spec.role ?? 'dimension' }]));
  const run = async (extra: any) => {
    let profileSqls = 0;
    const client: any = { runSql: async (sql: string) => { if (/concordia_rows/.test(sql)) profileSqls++; return { sql, requestId: 'r', queryId: 'q', rows: /concordia_rows/.test(sql) ? [[10, 10, 0]] : [['320193']], durationMs: 1, utc: '2026-10-23T00:00:00.000Z' }; } };
    const result = await probeUniverse('U2', { inventory: { tables: tablesInv() }, client, persist: false, relationIds: ['cik_text_trap'], now: () => '2026-10-23T00:02:00Z', probeMode: 'distinct-keys', dispersedSeeds: false, fullEvidence: true, ...extra });
    return { profileSqls, decision: JSON.stringify(result.relations[0].evidence.decision) };
  };
  const cache = createProfileCache();
  const first = await run({ profileCache: cache }), second = await run({ profileCache: cache }), uncached = await run({});
  assert.equal(second.profileSqls, 0, 'the second call reads every profile from the shared cache');
  assert.ok(first.profileSqls > 0 && uncached.profileSqls === first.profileSqls);
  assert.equal(second.decision, uncached.decision); assert.equal(first.decision, uncached.decision);
});
