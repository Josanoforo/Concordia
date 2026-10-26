import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runMemoryResolveStaleCommand } from '../src/agent/cli-memory-stale.ts';
import { usageFor } from '../src/agent/cli-help.ts';
import { AGENT_MEMORY_ACTOR } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';

const made: string[] = []; let lastChild = '';
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const claim = (entity: string) => ({ entity, attribute: 'status', value: 'SOSTENIDA', source: 's:' + entity, confidence: 0.9, requestIds: ['q-' + entity], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });
function scope() {
  const root = fs.mkdtempSync(path.join(ROOT, '.concordia', 'stale-cli-test-')); made.push(root);
  const dir = path.join(root, 'LOCAL-SYNTHETIC'), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const base = r.addClaim(claim('relation:a')), child = r.addClaim({ ...claim('relation:b'), value: 'INDETERMINADA' }, false, [base.id]);
  r.invalidate(base.id, 'source replaced');
  lastChild = child.id; return { dir, base, child };
}
const args = (dir: string, over: Record<string, unknown> = {}) => ({ universe: 'AGENTFX', dir, claim: lastChild, decision: 'keep', reviewer: 'ana.reviewer', reason: 'checked against the source', now: () => new Date(Date.now() + 1000).toISOString(), ...over });
const quiet = <T>(fn: () => T): T => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const states = (dir: string) => new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR).claims.map(c => [c.id, c.staleAt !== undefined, c.invalidatedAt !== undefined]);

test('F1: reviewer, reason, decision and claim are mandatory; the agent actor is not a reviewer; nothing is written on refusal', () => {
  const { dir, child } = scope(), before = JSON.stringify(states(dir));
  for (const [over, code] of [[{ reviewer: undefined }, 'HUMAN_REVIEWER_REQUIRED'], [{ reviewer: '  ' }, 'HUMAN_REVIEWER_REQUIRED'], [{ reviewer: AGENT_MEMORY_ACTOR, claim: child.id }, 'HUMAN_REVIEWER_REQUIRED'], [{ reason: undefined, claim: child.id }, 'STALE_REASON_REQUIRED'],
    [{ decision: 'maybe', claim: child.id }, 'STALE_DECISION_INVALID'], [{ claim: undefined }, 'STALE_CLAIM_REQUIRED'], [{ claim: 'ghost' }, 'CLAIM_NOT_FOUND']] as const)
    assert.throws(() => runMemoryResolveStaleCommand(args(dir, over as any) as any), new RegExp(code), code);
  assert.equal(JSON.stringify(states(dir)), before);
});

test('F1: --dry-run reports what would change and writes nothing', () => {
  const { dir, child } = scope(), before = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  const out = quiet(() => runMemoryResolveStaleCommand(args(dir, { claim: child.id, dryRun: true })));
  assert.equal(out.mode, 'DRY_RUN'); assert.equal(out.written, 0); assert.equal(out.apiDecision, 'CONFIRM'); assert.equal(out.reviewer, 'ana.reviewer'); assert.ok(out.wouldChange);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8'), before);
  assert.deepEqual(states(dir).find(s => s[0] === child.id), [child.id, true, false]);
});

test('F1: keep re-affirms the stale claim and close invalidates it; the reviewer lands in the claim and the ledger', () => {
  const kept = scope(), closed = scope();
  quiet(() => runMemoryResolveStaleCommand(args(kept.dir, { claim: kept.child.id })));
  const after = new Reconciler('AGENTFX', kept.dir, AGENT_MEMORY_ACTOR), c = after.claims.find(x => x.id === kept.child.id)!;
  assert.equal(c.staleAt, undefined); assert.equal(c.staleResolution?.reviewer, 'ana.reviewer'); assert.equal(c.staleResolution?.decision, 'CONFIRM'); assert.equal(c.staleResolution?.note, 'checked against the source');
  assert.ok(fs.readFileSync(path.join(kept.dir, 'ledger.jsonl'), 'utf8').includes('ana.reviewer'));
  quiet(() => runMemoryResolveStaleCommand(args(closed.dir, { claim: closed.child.id, decision: 'close' })));
  const gone = new Reconciler('AGENTFX', closed.dir, AGENT_MEMORY_ACTOR).claims.find(x => x.id === closed.child.id)!;
  assert.ok(gone.invalidatedAt); assert.equal(gone.staleResolution?.decision, 'INVALIDATE');
  assert.throws(() => runMemoryResolveStaleCommand(args(closed.dir, { claim: closed.child.id })), /CLAIM_NOT_STALE/);
});

test('F1: the scope must be explicit and inside .concordia; the usage documents the command', () => {
  assert.throws(() => runMemoryResolveStaleCommand({ universe: 'AGENTFX', claim: 'c', decision: 'keep', reviewer: 'a', reason: 'r' }), /MEMORY_ORIGIN_REQUIRED/);
  assert.throws(() => runMemoryResolveStaleCommand({ universe: 'AGENTFX', claim: 'c', decision: 'keep', reviewer: 'a', reason: 'r', dir: path.join(ROOT, 'src') }), /MEMORY_SCOPE_OUTSIDE_APPROVED_ROOT/);
  assert.match(usageFor(['node', 'cli', 'memory-resolve-stale'])!, /--reviewer <id> --reason <text>/);
});
