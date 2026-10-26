import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ORIGIN_SEAL_FILE, planLegacySeals, sealLegacyAgentMemory } from '../src/agent/memory.ts';
import { runMemorySealLegacyCommand } from '../src/agent/cli-memory-seal.ts';
import { usageFor } from '../src/agent/cli-help.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';

/** concordia memory-seal-legacy: dry run and seal over a TEMPORARY root. The real .concordia/agent-memory is never touched by these tests. */
const made: string[] = [];
const tempRoot = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'seal-legacy-')); made.push(dir); return dir; };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const claim = (entity: string, over: Record<string, unknown> = {}) => ({ entity: 'relation:' + entity, attribute: 'status', value: 'SOSTENIDA', source: `${entity}.src`, confidence: 0.9, requestIds: ['req-1'], sourceVersion: 'rv1:x', observedAt: '2026-10-20T00:00:00Z', rule: 'bounded_key_overlap', runId: 'run-legacy', reviewState: 'REVIEWED', ...over });
function legacyTree() {
  const root = tempRoot(), named = path.join(root, 'GTFSAGENT', 'LIVE-PUBLIC'), bare = path.join(root, 'U2');
  const r = new Reconciler('GTFSAGENT', named, 'concordia-agent');
  r.addClaim(claim('good') as any);
  r.addClaim(claim('no_stamp', { reviewState: undefined }) as any);
  r.addClaim(claim('pending', { reviewState: 'PENDING' }) as any);
  r.addClaim(claim('no_version', { sourceVersion: undefined }) as any);
  r.addClaim(claim('no_receipt', { requestIds: [] }) as any);
  r.addClaim(claim('good', { value: 'INDETERMINADA', source: 'other.src', requestIds: [], reviewState: undefined, runId: undefined }) as any);
  new Reconciler('U2', bare, 'concordia-agent').addClaim(claim('cik') as any);
  return { root, named, bare };
}
const bytes = (dir: string) => Object.fromEntries(['claims.json', 'state.json', 'ledger.jsonl'].map(name => [name, fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : null]));

test('dry run: lists each scope with its origin and the reusable and non-reusable claim counts, and writes nothing', () => {
  const { root, named, bare } = legacyTree(), before = [bytes(named), bytes(bare)];
  const summary = runMemorySealLegacyCommand({ dryRun: true, root });
  assert.equal(summary.mode, 'DRY_RUN'); assert.equal(summary.written, 0); assert.deepEqual(summary.sealed, []);
  const byScope = Object.fromEntries(summary.scopes.map(scope => [path.basename(scope.scope), scope]));
  assert.deepEqual([byScope['LIVE-PUBLIC'].status, byScope['LIVE-PUBLIC'].sealedBy, byScope['LIVE-PUBLIC'].origin], ['WOULD_SEAL', 'INFERRED_FROM_DIRECTORY', { executionMode: 'LIVE', dataOrigin: 'PUBLIC' }]);
  assert.deepEqual(byScope['LIVE-PUBLIC'].claims, { total: 6, sustainedActive: 5, reusable: 1, notReusable: { NO_REVIEW_STATE: 1, REVIEW_NOT_REVIEWED: 1, PLACEHOLDER_SOURCE_VERSION: 1, NO_RUN_OR_RECEIPT: 1 } });
  assert.deepEqual([byScope.U2.sealedBy, byScope.U2.origin, byScope.U2.claims.reusable, byScope.U2.claims.notReusable], ['LEGACY_UNSCOPED', { executionMode: 'UNKNOWN', dataOrigin: 'UNKNOWN' }, 0, { SCOPE_ORIGIN_UNKNOWN: 1 }]);
  assert.deepEqual([summary.totals.scopes, summary.totals.wouldSeal, summary.totals.alreadySealed, summary.totals.reusable, summary.totals.sustainedActive], [2, 2, 0, 1, 6]);
  for (const dir of [named, bare]) assert.equal(fs.existsSync(path.join(dir, ORIGIN_SEAL_FILE)), false, 'a dry run writes no seal');
  assert.deepEqual([bytes(named), bytes(bare)], before, 'a dry run does not touch a single byte of claims, state or ledger');
});

test('sealing writes one seal per scope, leaves claims and ledger byte for byte, and is idempotent', () => {
  const { root, named, bare } = legacyTree(), before = [bytes(named), bytes(bare)];
  const first = runMemorySealLegacyCommand({ dryRun: false, root });
  assert.equal(first.mode, 'SEALED'); assert.equal(first.written, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(named, ORIGIN_SEAL_FILE), 'utf8')).sealedBy, 'INFERRED_FROM_DIRECTORY');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bare, ORIGIN_SEAL_FILE), 'utf8')).sealedBy, 'LEGACY_UNSCOPED');
  assert.deepEqual([bytes(named), bytes(bare)], before, 'no claim, state or ledger byte changed');
  const sealBytes = fs.readFileSync(path.join(named, ORIGIN_SEAL_FILE), 'utf8');
  const second = runMemorySealLegacyCommand({ dryRun: false, root });
  assert.equal(second.written, 0); assert.ok(second.scopes.every(scope => scope.status === 'ALREADY_SEALED'));
  assert.equal(fs.readFileSync(path.join(named, ORIGIN_SEAL_FILE), 'utf8'), sealBytes, 'a second run rewrites nothing');
  assert.equal(planLegacySeals(root).totals.reusable, 1); assert.deepEqual(sealLegacyAgentMemory(root).map(item => item.sealedBy), ['ALREADY_SEALED', 'ALREADY_SEALED']);
});

test('the command refuses a root outside .concordia, is documented, and runs from the CLI as a dry run', () => {
  assert.throws(() => runMemorySealLegacyCommand({ dryRun: true, root: path.join(ROOT, 'out') }), /MEMORY_SEAL_ROOT_OUTSIDE_APPROVED_ROOT/);
  assert.throws(() => runMemorySealLegacyCommand({ dryRun: true, root: path.join(ROOT, '..') }), /MEMORY_SEAL_ROOT_OUTSIDE_APPROVED_ROOT/);
  assert.match(usageFor(['node', 'cli', 'memory-seal-legacy'])!, /--dry-run/);
  const { root } = legacyTree();
  const run = spawnSync(process.execPath, ['scripts/run-tsx.mjs', 'src/cli.ts', 'memory-seal-legacy', '--dry-run', '--root', root], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
  assert.deepEqual([out.mode, out.written, out.totals.scopes, out.totals.reusable], ['DRY_RUN', 0, 2, 1]);
  assert.equal(fs.existsSync(path.join(root, 'U2', ORIGIN_SEAL_FILE)), false);
});
