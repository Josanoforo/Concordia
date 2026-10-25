import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import { candidateIdentity, deduplicateContributions, discover, generateCandidates, produceCandidates, withUniverseContext, type CandidateContribution, type CandidateProvider, type Discovery } from '../src/discovery/index.ts';
import type { Candidate } from '../src/contracts/types.ts';
import { universe } from '../src/universe.ts';

const known = <T>(value: T) => ({ state: 'KNOWN' as const, value });
function fixtureCandidate(options: { universeId?: string; fromTable?: string; fromColumns?: string[]; toTable?: string; toColumns?: string[]; kind?: 'FOREIGN_KEY' | 'IDENTITY'; normalization?: string; typedValue?: string | number; status?: Candidate['status']; createdAt?: string } = {}): Candidate {
  const fromTable = options.fromTable ?? 'child', toTable = options.toTable ?? 'parent';
  const relationDraft = legacyRelationContract({ id: 'legacy-delimited-id', from: { db: 'fixture-db', table: fromTable, column: options.fromColumns?.[0] ?? 'parent_id' }, to: { db: 'fixture-db', table: toTable, column: options.toColumns?.[0] ?? 'id' }, kind: options.kind ?? 'FOREIGN_KEY', reviewState: 'PENDING' }, options.universeId ?? 'fixture-A', '1.0', 'integer', 1);
  relationDraft.from.orderedColumns = [...(options.fromColumns ?? ['parent_id'])];
  relationDraft.to.orderedColumns = [...(options.toColumns ?? ['id'])];
  if (options.normalization) relationDraft.normalization[0].operation = known(options.normalization);
  if (options.typedValue !== undefined) relationDraft.semanticContext.properties = { typedValue: known(options.typedValue) };
  return { schemaVersion: 1, candidateId: 'uuid-that-is-not-identity', relationDraft, proposedBy: 'source-one', provenance: ['source-one'], createdAt: known(options.createdAt ?? '2026-01-01T00:00:00Z'), status: options.status ?? 'INCOMPLETE' };
}
function legacy(id: string, reason: string, confidence: number, methodId: string) {
  return { id, from: { db: 'fixture-db', table: 'child', column: 'parent_id' }, to: { db: 'fixture-db', table: 'parent', column: 'id' }, reason: [reason], proposedBy: 'heuristic' as const, proposedBySources: ['heuristic'], methodIds: [methodId], confidence };
}
function contribution(candidate: Candidate, reason: string, providerId: string, confidence = 0.7): CandidateContribution {
  return { candidate: { ...candidate, proposedBy: providerId, provenance: [providerId], createdAt: known(`${providerId}-time`) }, methodId: providerId, reasons: [reason], evidenceRefs: [`evidence:${providerId}`], legacyCandidate: legacy('child.parent_id__parent.id', reason, confidence, providerId) };
}
function provider(providerId: string, produce: CandidateProvider['produce'], capability: 'SUPPORTED' | 'UNSUPPORTED' = 'SUPPORTED'): CandidateProvider {
  return { descriptor: { providerId, version: '1.0', method: 'fixture-rule', capability }, produce };
}
const productionInput = {
  universeId: 'fixture-A', sourceId: 'source:fixture', sourceVersion: { state: 'UNKNOWN' as const }, configFingerprint: 'config-hash', inputHash: 'input-hash',
  scope: { tables: ['child', 'parent'], columns: ['parent_id', 'id'] }, executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const,
  tableMetadata: { child: { columns: [{ name: 'parent_id', type: 'integer' }], keyColumns: ['parent_id'], role: 'fact' }, parent: { columns: [{ name: 'id', type: 'integer' }], keyColumns: ['id'], role: 'dimension' } }, evidenceRefs: ['sample:1']
};

test('candidate semantic identity is structural, typed and independent of UUID, timestamp and provider order', () => {
  const base = fixtureCandidate({ typedValue: '01' });
  const recreated = { ...base, candidateId: 'different-uuid', createdAt: known('2026-10-23T00:00:00Z'), proposedBy: 'another-provider', provenance: ['another-provider'] };
  assert.equal(candidateIdentity(base), candidateIdentity(recreated));
  assert.notEqual(candidateIdentity(base), candidateIdentity(fixtureCandidate({ typedValue: '1' })));
  assert.notEqual(candidateIdentity(base), candidateIdentity(fixtureCandidate({ typedValue: 1 })));
  assert.notEqual(candidateIdentity(base), candidateIdentity(fixtureCandidate({ kind: 'IDENTITY', typedValue: '01' })));
  assert.notEqual(candidateIdentity(base), candidateIdentity(fixtureCandidate({ normalization: 'text', typedValue: '01' })));
  assert.notEqual(candidateIdentity(base), candidateIdentity(fixtureCandidate({ fromTable: 'a.b', fromColumns: ['c'], typedValue: '01' })));
  assert.notEqual(candidateIdentity(fixtureCandidate({ fromTable: 'a.b', fromColumns: ['c'] })), candidateIdentity(fixtureCandidate({ fromTable: 'a', fromColumns: ['b.c'] })));
  assert.notEqual(candidateIdentity(fixtureCandidate({ fromColumns: ['a', 'b'] })), candidateIdentity(fixtureCandidate({ fromColumns: ['b', 'a'] })));
  const reorderedComponents = fixtureCandidate({ typedValue: '01' });
  reorderedComponents.relationDraft.normalization.push({ componentIndex: 1, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('text') });
  const reverseComponents = structuredClone(reorderedComponents);
  reverseComponents.relationDraft.normalization.reverse();
  assert.notEqual(candidateIdentity(reorderedComponents), candidateIdentity(reverseComponents));
  assert.notEqual(candidateIdentity(base), candidateIdentity(fixtureCandidate({ universeId: 'fixture-B', typedValue: '01' })));
});

test('candidate identity ignores assertion authorship, IDs, timestamps and Unknown provenance while merging their records', () => {
  const candidateA = fixtureCandidate();
  candidateA.relationDraft.identifierSpace = { state: 'KNOWN', value: 'customer-key', provenance: 'config-a' };
  candidateA.relationDraft.assertions = [{ assertionId: 'assertion-uuid-a', claim: 'child key refers to parent key', actor: known('analyst-a'), sourceRef: known('review-a'), assertedAt: known('2026-01-01T00:00:00Z'), scope: { state: 'KNOWN', value: 'tenant 7', provenance: 'scope-a' } }];
  const candidateB = structuredClone(candidateA);
  candidateB.candidateId = 'another-uuid';
  candidateB.relationDraft.reviewState = 'UNKNOWN';
  candidateB.relationDraft.identifierSpace = { state: 'KNOWN', value: 'customer-key', provenance: 'config-b' };
  candidateB.relationDraft.assertions = [{ assertionId: 'assertion-uuid-b', claim: 'child key refers to parent key', actor: known('analyst-b'), sourceRef: known('review-b'), assertedAt: known('2026-10-23T20:00:00Z'), scope: { state: 'KNOWN', value: 'tenant 7', provenance: 'scope-b' } }];
  assert.equal(candidateIdentity(candidateA), candidateIdentity(candidateB));
  const merged = deduplicateContributions([contribution(candidateA, 'first assertion', 'provider-a'), contribution(candidateB, 'second assertion', 'provider-b')]);
  assert.equal(merged.candidates.length, 1);
  assert.equal(merged.candidates[0].relationDraft.reviewState, 'UNKNOWN');
  assert.deepEqual(merged.candidates[0].relationDraft.assertions.map(assertion => assertion.assertionId), ['assertion-uuid-a', 'assertion-uuid-b']);
  assert.equal(merged.candidates[0].relationDraft.identifierSpace.state, 'KNOWN');
  if (merged.candidates[0].relationDraft.identifierSpace.state === 'KNOWN') {
    assert.deepEqual(JSON.parse(merged.candidates[0].relationDraft.identifierSpace.provenance!), ['config-a', 'config-b']);
  }
  const differentClaim = structuredClone(candidateB);
  differentClaim.relationDraft.assertions[0].claim = 'unrelated child and parent keys';
  assert.notEqual(candidateIdentity(candidateA), candidateIdentity(differentClaim));
  const differentScope = structuredClone(candidateB);
  differentScope.relationDraft.assertions[0].scope = known('tenant 8');
  assert.notEqual(candidateIdentity(candidateA), candidateIdentity(differentScope));
  const reviewed = structuredClone(candidateA);
  reviewed.relationDraft.reviewState = 'REVIEWED';
  const pendingAndReviewed = deduplicateContributions([contribution(candidateA, 'pending source', 'provider-a'), contribution(reviewed, 'reviewed source', 'provider-b')]);
  assert.equal(pendingAndReviewed.candidates[0].relationDraft.reviewState, 'PENDING');
});

test('candidate dedup is order independent, preserves provenance and reasons, and produces one downstream query', () => {
  const candidate = fixtureCandidate();
  const a = contribution(candidate, 'key-family match', 'provider-a', 0.8);
  const b = contribution({ ...candidate, status: 'PROPOSED' }, 'paired label match', 'provider-b', 0.4);
  const left = deduplicateContributions([a, b]);
  const right = deduplicateContributions([b, a]);
  assert.deepEqual(left, right);
  assert.equal(left.candidates.length, 1);
  assert.equal(left.candidates[0].status, 'INCOMPLETE');
  assert.deepEqual(left.candidates[0].provenance, ['provider-a', 'provider-b']);
  assert.deepEqual(left.contributions[0].reasons, ['key-family match', 'paired label match']);
  assert.deepEqual(left.contributions[0].evidenceRefs, ['evidence:provider-a', 'evidence:provider-b']);
  assert.deepEqual(left.contributions[0].methodIds, ['provider-a', 'provider-b']);
  assert.equal(left.legacyCandidates[0].confidence, 0.4);
  let queryInvocations = 0;
  for (const candidateForQuery of left.legacyCandidates) { assert.equal(candidateForQuery.id, 'child.parent_id__parent.id'); queryInvocations++; }
  assert.equal(queryInvocations, 1);
});

test('CandidateProvider separates complete, abstained, partial, failed and disabled provider states', async () => {
  const candidate = fixtureCandidate();
  let disabledCalls = 0, unsupportedCalls = 0;
  const first = provider('provider-a', () => ({ contributions: [contribution(candidate, 'first reason', 'provider-a')], abstentions: [], errors: [], partial: false, limitations: [] }));
  const second = provider('provider-b', () => ({ contributions: [contribution(candidate, 'second reason', 'provider-b')], abstentions: [], errors: [], partial: false, limitations: [] }));
  const disabled = provider('disabled', () => { disabledCalls++; return { contributions: [], abstentions: [], errors: [], partial: false, limitations: [] }; });
  const combined = await produceCandidates(productionInput, [first, second, disabled], ['provider-a', 'provider-b']);
  assert.equal(combined.executionMode, 'LOCAL'); assert.equal(combined.dataOrigin, 'SYNTHETIC'); assert.equal(combined.inputHash, 'input-hash');
  assert.equal(combined.candidates.length, 1); assert.equal(combined.contributions[0].reasons.length, 2); assert.equal(disabledCalls, 0);
  assert.equal(combined.providers.find(item => item.providerId === 'disabled')?.enabled, false);
  assert.equal(combined.providerStates.find(item => item.providerId === 'disabled')?.status, 'DISABLED');
  const publicOutput = await produceCandidates({ ...productionInput, dataOrigin: 'PUBLIC' }, [first]);
  assert.equal(publicOutput.dataOrigin, 'PUBLIC');
  const disabledOnly = await produceCandidates(productionInput, [first, second], ['provider-b']);
  assert.deepEqual(disabledOnly.candidates[0].provenance, ['provider-b', 'provider-b@1.0:provider-b']);
  assert.deepEqual(disabledOnly.contributions[0].reasons, ['second reason']);
  assert.equal(disabledOnly.providerStates.find(item => item.providerId === 'provider-a')?.status, 'DISABLED');
  const abstained = await produceCandidates(productionInput, [provider('empty', () => ({ contributions: [], abstentions: [{ reason: 'NO_MATCH' }], errors: [], partial: false, limitations: ['bounded fixture'] }))]);
  assert.equal(abstained.status, 'ABSTAINED'); assert.equal(abstained.abstentions[0].reason, 'NO_MATCH');
  assert.equal(abstained.limitations[0], 'bounded fixture');
  const partial = await produceCandidates(productionInput, [provider('partial', () => ({ contributions: [contribution(candidate, 'known partial', 'partial')], abstentions: [], errors: [{ code: 'SOURCE_INCOMPLETE', partial: true }], partial: true, limitations: [] }))]);
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.errors.some(error => error.code === 'SOURCE_INCOMPLETE'), true);
  assert.equal(partial.reviewQueue[0].state, 'PENDING'); assert.equal(partial.candidates[0].relationDraft.reviewState, 'PENDING');
  const failed = await produceCandidates(productionInput, [provider('failed', () => { throw new Error('LOCAL_FIXTURE_FAILURE'); })]);
  assert.equal(failed.status, 'ERROR'); assert.equal(failed.errors[0].code, 'Error');
  const unsupported = await produceCandidates(productionInput, [provider('unsupported', () => { unsupportedCalls++; return { contributions: [], abstentions: [], errors: [], partial: false, limitations: [] }; }, 'UNSUPPORTED')]);
  assert.equal(unsupported.status, 'ABSTAINED'); assert.equal(unsupported.abstentions[0].reason, 'CAPABILITY_UNSUPPORTED'); assert.equal(unsupportedCalls, 0);
  await assert.rejects(() => produceCandidates({ ...productionInput, inputHash: '' }, [first]), /CANDIDATE_PRODUCTION_CONTEXT_INVALID/);
  await assert.rejects(() => produceCandidates(productionInput, [first, first]), /CANDIDATE_PROVIDERS_INVALID/);
  await assert.rejects(() => produceCandidates(productionInput, [first], ['unregistered']), /CANDIDATE_PROVIDER_NOT_REGISTERED/);
  const configuredProvider = provider('config-only', context => {
    const configuredCandidate = fixtureCandidate({ universeId: context.descriptor.universeId });
    configuredCandidate.relationDraft = withUniverseContext(configuredCandidate.relationDraft, { id: context.descriptor.universeId, configFingerprint: context.descriptor.configFingerprint });
    configuredCandidate.relationDraft.from.sourceId = `${context.descriptor.sourceId}:child@UNKNOWN:from`;
    configuredCandidate.relationDraft.to.sourceId = `${context.descriptor.sourceId}:parent@UNKNOWN:to`;
    const item = contribution(configuredCandidate, 'configured fixture rule', 'config-only');
    return { contributions: [item], abstentions: [], errors: [], partial: false, limitations: [] };
  });
  const alternateUniverse = await produceCandidates({ ...productionInput, universeId: 'vendor.configured-fixture', configFingerprint: 'alternate-config-hash' }, [configuredProvider]);
  assert.equal(alternateUniverse.candidates[0].relationDraft.universeRef.universeId, 'vendor.configured-fixture');
  assert.equal(alternateUniverse.providers[0].configFingerprint, 'alternate-config-hash');
});

test('public U1 discovery uses CandidateProvider with injected SQL metadata and preserves legacy candidates', async () => {
  const config = universe();
  const sqlCalls: string[] = [];
  const client = {
    async listDatabases() { return { rows: [[config.database]], requestId: 'synthetic-db-list' }; },
    async listTables() { return { rows: Object.keys(config.tables).map(name => [name]), requestId: 'synthetic-table-list' }; },
    async describe(_db: string, table: string) { return { rows: config.tables[table].columns.map(column => [column.name, column.type]), requestId: `synthetic-describe-${table}` }; },
    async runSql(sql: string) {
      sqlCalls.push(sql);
      const table = Object.keys(config.tables).find(name => sql.includes(`.${name} `))!;
      const columns = config.tables[table].columns.map(column => column.name);
      return { sql, requestId: `synthetic-sample-${table}`, queryId: `synthetic-query-${table}`, rows: [columns.map(() => '01')], durationMs: 0, utc: '2026-10-23T00:00:00.000Z' };
    }
  };
  const output: Discovery = await discover({ client: client as any, persist: false, executionMode: 'LOCAL' });
  assert.equal(sqlCalls.length, Object.keys(config.tables).length);
  assert.equal(output.candidateProduction?.status, 'COMPLETE');
  assert.equal(output.live, false);
  assert.equal(output.candidateProduction?.executionMode, 'LOCAL');
  assert.equal(output.candidateProduction?.dataOrigin, 'UNKNOWN');
  assert.equal(output.candidateProduction?.providers[0].method, 'key-family+paired-label-catalog');
  assert.equal(output.candidateProduction?.inputHash.length, 64);
  assert.deepEqual(output.candidates, output.candidateProduction?.legacyCandidates);
  assert.equal(output.candidates.every(item => item.id.length > 0 && item.reason.length > 0 && item.confidence > 0), true);
  assert.equal(output.candidateProduction?.candidates.every(item => item.status === 'INCOMPLETE' && item.relationDraft.reviewState === 'PENDING'), true);
  const queryIds: string[] = [];
  for (const candidateForQuery of output.candidates) queryIds.push(candidateForQuery.id);
  assert.equal(queryIds.length, new Set(queryIds).size);
  assert.equal(output.candidateProduction?.contributions.every(item => item.evidenceRefs.length > 0), true);
  const methods = new Set(output.candidateProduction?.contributions.flatMap(item => item.methodIds ?? []));
  assert.equal(methods.has('key-family'), true); assert.equal(methods.has('paired-label-catalog'), true);
  const legacyCandidates = generateCandidates(output.tables, config.database);
  for (const candidate of output.candidates) {
    const prior = legacyCandidates.filter(item => item.id === candidate.id);
    assert.ok(prior.length > 0);
    assert.deepEqual(candidate.reason, [...new Set(prior.flatMap(item => item.reason))]);
    assert.equal(candidate.confidence, Math.min(...prior.map(item => item.confidence)));
  }
});

test('COMA joins normal discovery as one more provider: diagnostics merge, out-of-scope proposals are retained, legacy candidates are unchanged', async () => {
  const config = universe();
  const client = {
    async listDatabases() { return { rows: [[config.database]], requestId: 'synthetic-db-list' }; },
    async listTables() { return { rows: Object.keys(config.tables).map(name => [name]), requestId: 'synthetic-table-list' }; },
    async describe(_db: string, table: string) { return { rows: config.tables[table].columns.map(column => [column.name, column.type]), requestId: `synthetic-describe-${table}` }; },
    async runSql(sql: string) {
      const table = Object.keys(config.tables).find(name => sql.includes(`.${name} `))!;
      return { sql, requestId: `synthetic-sample-${table}`, queryId: `q-${table}`, rows: [config.tables[table].columns.map(() => '01')], durationMs: 0, utc: '2026-10-23T00:00:00.000Z' };
    }
  };
  const baseline: Discovery = await discover({ client: client as any, persist: false, executionMode: 'LOCAL' });
  let seenPairs = 0, sentValues = false;
  const withComa: Discovery = await discover({ client: client as any, persist: false, executionMode: 'LOCAL', coma: input => {
    seenPairs = input.pairs.length;
    sentValues = JSON.stringify(input).includes('"01"');
    return { schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', configuration: { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0.0, instance_weight: 1.0 },
      matches: input.pairs.map(pair => {
        const allowed = pair.allowed[0];
        const other = input.tables[pair.source].columns.find(column => column !== allowed.sourceColumn);
        return { source: pair.source, target: pair.target, matches: [{ sourceColumn: allowed.sourceColumn, targetColumn: allowed.targetColumn, rawScore: 0.9 },
          ...(other ? [{ sourceColumn: other, targetColumn: allowed.targetColumn, rawScore: 0.5 }] : [])] };
      }) };
  } });
  assert.ok(seenPairs > 0); assert.equal(sentValues, false, 'COMA receives schema only');
  assert.deepEqual(withComa.candidates.map(item => item.id), baseline.candidates.map(item => item.id));
  assert.equal(withComa.candidateProduction?.providers.some(item => item.providerId === 'valentine.coma'), true);
  assert.equal(withComa.candidateProduction?.contributions.some(item => item.diagnostics?.some(d => d.provider === 'valentine.Coma')), true);
  assert.ok((withComa.candidateProduction?.outOfScopeProposals?.length ?? 0) > 0);
  assert.equal(withComa.candidateProduction?.outOfScopeProposals?.every(item => item.verificationStatus === 'NO VERIFICADO/UNKNOWN' && item.reviewState === 'PENDING'), true);
  const candidateIds = new Set(withComa.candidateProduction?.candidates.map(item => item.candidateId));
  assert.equal(withComa.candidateProduction?.outOfScopeProposals?.some(item => candidateIds.has(`${item.from.table}.${item.from.column}__${item.to.table}.${item.to.column}`)), false);
  const failing: Discovery = await discover({ client: client as any, persist: false, executionMode: 'LOCAL', coma: () => { throw new Error('COMA_TIMEOUT'); } });
  assert.deepEqual(failing.candidates.map(item => item.id), baseline.candidates.map(item => item.id));
  assert.equal(failing.candidateProduction?.providerStates.find(item => item.providerId === 'valentine.coma')?.status, 'ERROR');
});
