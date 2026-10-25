import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBoundedRows, parseAdaptiveChoice, u2ProtectedArtifactPaths } from '../src/agent/u2.ts';

const cfg = { normalizationContract: { modes: { text: {}, integer: {}, 'integer-pad10': {} } } };

test('adaptive U2 accepts only enumerated actions and measures configured key and descriptive alternatives', () => {
  assert.deepEqual(parseAdaptiveChoice('{"action":"READ_SEC_PROFILE","reason":"The observed CIK can target a bounded SEC read."}', ['READ_SEC_PROFILE', 'STOP_EXPLORATION']),
    { action: 'READ_SEC_PROFILE', reason: 'The observed CIK can target a bounded SEC read.' });
  assert.throws(() => parseAdaptiveChoice('{"action":"SELECT * FROM anything","reason":"run arbitrary model SQL"}', ['READ_SEC_PROFILE', 'STOP_EXPLORATION']), /U2_ADAPTIVE_RESPONSE_INVALID/);

  const factRows = [['320193']], factColumns = ['cik'];
  const secRows = [['0000320193', '3571', 'Electronic Computers']], secColumns = ['cik', 'sic', 'sicDescription'];
  const dnsRows = [['3571', 'Electronic Computers'], ['3571', 'Other Computers']], dnsColumns = ['sic_code', 'description'];
  const base = { sourceEvidence: ['sec-query'], targetEvidence: ['dns-query'], cfg };
  const cikText = compareBoundedRows({ ...base, choice: 'CIK_TEXT', from: 'facts.cik', to: 'submissions.cik', normalization: 'text', sourceRows: factRows,
    sourceColumns: factColumns, targetRows: secRows, targetColumns: secColumns, sourceColumn: 'cik', targetColumn: 'cik' });
  const cikNormalized = compareBoundedRows({ ...base, choice: 'CIK_NORMALIZED', from: 'facts.cik', to: 'submissions.cik', normalization: 'integer-pad10', sourceRows: factRows,
    sourceColumns: factColumns, targetRows: secRows, targetColumns: secColumns, sourceColumn: 'cik', targetColumn: 'cik' });
  const sicCode = compareBoundedRows({ ...base, choice: 'SIC_CODE', from: 'submissions.sic', to: 'dns.sic_code', normalization: 'integer', sourceRows: secRows,
    sourceColumns: secColumns, targetRows: dnsRows, targetColumns: dnsColumns, sourceColumn: 'sic', targetColumn: 'sic_code' });
  const description = compareBoundedRows({ ...base, choice: 'SIC_DESCRIPTION', from: 'submissions.sicDescription', to: 'dns.description', normalization: 'text', sourceRows: secRows,
    sourceColumns: secColumns, targetRows: dnsRows, targetColumns: dnsColumns, sourceColumn: 'sicDescription', targetColumn: 'description' });
  assert.equal(cikText.matchPairs, 0);
  assert.equal(cikNormalized.matchPairs, 1);
  assert.equal(sicCode.matchPairs, 2);
  assert.equal(sicCode.ambiguousSourceRows, 1);
  assert.equal(description.matchPairs, 1, 'description comparison is separate from the ambiguous code-only match');
  assert.equal(description.normalization, 'text', 'descriptions use literal configured text equality');
  assert.equal(description.sampleBounded, true);
});

test('compact adaptive retry accepts a short bounded reason and rejects an overlong response', () => {
  assert.deepEqual(parseAdaptiveChoice('{"action":"SIC_CODE_AND_DESCRIPTION","reason":"1/1 observed pair; no sampled duplicates."}',
    ['SIC_CODE_AND_DESCRIPTION', 'NO_JOIN'], 60),
  { action: 'SIC_CODE_AND_DESCRIPTION', reason: '1/1 observed pair; no sampled duplicates.' });
  assert.throws(() => parseAdaptiveChoice('{"action":"SIC_CODE_AND_DESCRIPTION","reason":"This reason is intentionally too long for the compact retry and exceeds sixty characters."}',
    ['SIC_CODE_AND_DESCRIPTION', 'NO_JOIN'], 60), /U2_ADAPTIVE_RESPONSE_INVALID/);
});

test('normal U2 integrity capture is independent of historical assessment and run artifacts', () => {
  const paths = u2ProtectedArtifactPaths();
  assert.equal(paths.length, 10);
  assert.deepEqual(paths.filter(path => path.startsWith('.concordia/U')), [
    '.concordia/U1/claims.json', '.concordia/U1/ledger.jsonl', '.concordia/U1/state.json',
    '.concordia/U2/claims.json', '.concordia/U2/ledger.jsonl', '.concordia/U2/state.json',
    '.concordia/U3/claims.json', '.concordia/U3/ledger.jsonl', '.concordia/U3/state.json'
  ]);
  assert.ok(paths.includes('evidence/trace.jsonl'));
  assert.ok(paths.every(path => !path.includes('assessments') && !path.includes('agent-runs')));
});
