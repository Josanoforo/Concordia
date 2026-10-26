import test from 'node:test';
import assert from 'node:assert/strict';
import { createComaProvider, type ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { produceCandidates } from '../src/discovery/candidates.ts';

const input: ComaSchemaInput = {
  database: 'fixture', normalizationMode: 'integer',
  tables: { source: { columns: ['source_id', 'other'], types: { source_id: 'integer', other: 'text' } }, target: { columns: ['id'], types: { id: 'integer' } } },
  pairs: [{ source: 'source', target: 'target', allowed: [{ sourceColumn: 'source_id', targetColumn: 'id', caseIds: ['case-1'] }] }]
};
const productionInput = {
  universeId: 'U1', sourceId: 'zetaris:fixture', sourceVersion: { state: 'UNKNOWN' as const }, configFingerprint: 'config-hash', inputHash: 'input-hash',
  scope: { tables: ['source', 'target'], columns: ['source_id', 'other', 'id'] }, executionMode: 'REPLAY' as const, dataOrigin: 'UNKNOWN' as const,
  tableMetadata: { source: { columns: [{ name: 'source_id', type: 'integer' }, { name: 'other', type: 'text' }], keyColumns: ['source_id'], role: 'fact' },
    target: { columns: [{ name: 'id', type: 'integer' }], keyColumns: ['id'], role: 'dimension' } }, evidenceRefs: ['snapshot:fixture']
};

test('COMA provider preserves diagnostic scores, projects configured pairs, abstains/errors without contradiction, and deduplicates', async () => {
  const provider = createComaProvider({ input, bridge: () => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: [
    { source: 'source', target: 'target', matches: [
      { sourceColumn: 'source_id', targetColumn: 'id', rawScore: 0.97 },
      { sourceColumn: 'source_id', targetColumn: 'id', rawScore: 0.96 },
      { sourceColumn: 'other', targetColumn: 'id', rawScore: 0.88 },
      { sourceColumn: 'other', targetColumn: 'id', rawScore: 0.87 }
    ] }
  ] }) });
  const result = await produceCandidates(productionInput, [provider]);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.contributions.length, 1);
  assert.equal(result.contributions[0].candidate.status, 'UNKNOWN');
  assert.equal(result.contributions[0].candidate.relationDraft.kind, 'UNKNOWN');
  assert.equal(result.contributions[0].candidate.relationDraft.reviewState, 'UNKNOWN');
  assert.deepEqual(result.contributions[0].diagnostics?.map(item => item.rawScore).sort(), [0.96, 0.97]);
  assert.equal(result.errors.some(item => item.code === 'COMA_COLUMN_PAIR_OUT_OF_SCOPE'), true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.reviewQueue.length, 1);
  assert.equal(result.outOfScopeProposals?.length, 1, 'an out-of-scope pair repeated by COMA is one proposal (G1: higher rawScore, then id); it is never merged into a candidate');
  assert.deepEqual(result.outOfScopeProposals?.map(item => item.rawScore), [0.88]);
  assert.deepEqual(result.outOfScopeProposals?.[0], {
    providerId: 'valentine.coma', providerVersion: '1.1.0', method: 'COMA',
    from: { db: 'fixture', table: 'source', column: 'other' }, to: { db: 'fixture', table: 'target', column: 'id' },
    rawScore: 0.88, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING',
    inputHash: 'input-hash', configHash: result.outOfScopeProposals?.[0].configHash, evidenceRefs: ['snapshot:fixture']
  });
  assert.equal(result.outOfScopeProposals?.some(item => item.from.column === 'other' && result.contributions.some(contribution => contribution.candidate.relationDraft.from.orderedColumns.includes(item.from.column))), false);

  const failed = createComaProvider({ input, bridge: () => { throw new Error('COMA_TIMEOUT'); } });
  const failedOutput = await produceCandidates(productionInput, [failed]);
  assert.equal(failedOutput.status, 'ERROR');
  assert.equal(failedOutput.errors[0].code, 'COMA_TIMEOUT');
  assert.equal(failedOutput.abstentions.length, 0);

  const empty = createComaProvider({ input, bridge: () => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: [] }) });
  const emptyOutput = await produceCandidates(productionInput, [empty]);
  assert.equal(emptyOutput.status, 'ABSTAINED');
  assert.equal(emptyOutput.abstentions[0].reason, 'COMA_NO_MATCHES_FOR_CONFIGURED_SCOPE');
});
