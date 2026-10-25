import test from 'node:test';
import assert from 'node:assert/strict';
import { runPostComa, coverageNormalization } from '../src/agent/post-coma.ts';
import { RunBudget, limitsFromBounds } from '../src/agent/run-budget.ts';

const cols = (...names: string[]) => names.map(name => ({ name, type: 'string' }));
const cfg = (defaultMode: string, relations: any[] = []) => ({
  normalizationContract: { defaultMode, modes: { text: {}, integer: {}, 'integer-pad10': {} } },
  tables: { filings: { db: 'D', physicalTable: 'filings', columns: cols('cik') }, companies: { db: 'D', physicalTable: 'companies', columns: cols('cik') } },
  relations, explorationCatalog: { postComa: { maxProbes: 2 } } });
const discovery = { tables: { filings: { columns: ['cik'], sample: { rows: [['320193'], ['789019']] } }, companies: { columns: ['cik'], sample: { rows: [] } } } };
const proposal = { providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'D', table: 'filings', column: 'cik' }, to: { db: 'D', table: 'companies', column: 'cik' }, rawScore: 0.9,
  reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] };
const run = async (config: any, rows: string[][]) => {
  const seen: string[] = [];
  const client = { async runSql(sql: string) { seen.push(sql); return { sql, rows, requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' }; } } as any;
  const report = await runPostComa({ cfg: config, catalog: config.explorationCatalog, discovery, proposals: [proposal], client, budget: new RunBudget(limitsFromBounds()) });
  return { report, seen, result: report.proposals[0].coverageProbe.result! };
};

test('F-02: literal text equality finds no coverage between 320193 and 0000320193', async () => {
  const { result, report } = await run(cfg('text'), [['0000320193']]);
  assert.equal(result.targetMatches, 0);
  assert.equal(report.policy.equality, 'literal text equality of sampled values');
  assert.deepEqual(result.normalization, { mode: 'text', source: 'UNIVERSE_DEFAULT', unnormalizableValues: 0 });
});

test('F-02: the declared pad10 normalization of a configured relation over the same columns makes padded CIKs cover', async () => {
  const relation = { id: 'filings_cik', from: { table: 'companies', column: 'cik' }, to: { table: 'filings', column: 'cik' }, normalization: 'integer-pad10' };
  const { result, seen } = await run(cfg('text', [relation]), [['0000320193']]);
  assert.deepEqual({ probed: result.probedValues, matches: result.targetMatches, ratio: result.ratio }, { probed: 2, matches: 1, ratio: 0.5 });
  assert.deepEqual(result.normalization, { mode: 'integer-pad10', source: 'RELATION', relationId: 'filings_cik', unnormalizableValues: 0 });
  assert.match(seen[0], /IN \('320193', '0000320193', '789019', '0000789019'\)/, 'both padded and unpadded forms are requested');
});

test('F-02: with no configured relation the universe default mode applies; undeclared modes fall back to text', async () => {
  const { result, report } = await run(cfg('integer-pad10'), [['0000789019']]);
  assert.equal(result.targetMatches, 1);
  assert.equal(result.normalization!.source, 'UNIVERSE_DEFAULT');
  assert.match(report.policy.equality, /declared normalization \(integer-pad10\)/);
  assert.equal(coverageNormalization(cfg('nope'), proposal).mode, 'text');
  assert.equal(coverageNormalization(cfg('text', [{ id: 'x', from: proposal.from, to: proposal.to, normalization: 'undeclared' }]), proposal).source, 'UNIVERSE_DEFAULT');
});

test('F-02: coverage stays a diagnostic under normalization: proposal remains unverified and pending', async () => {
  const { report } = await run(cfg('integer-pad10'), [['0000789019']]);
  assert.equal(report.proposals[0].verificationStatus, 'NO VERIFICADO/UNKNOWN');
  assert.equal(report.proposals[0].reviewState, 'PENDING');
});
