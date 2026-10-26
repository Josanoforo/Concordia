import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { exportOdcs, exportUslOdcs, toYaml } from '../src/export/odcs.ts';
import { validateAgainst, parseEmittedYaml } from './export-odcs-schema-validate.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';

const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'odcs', 'odcs-json-schema-v3.1.0.json'), 'utf8'));
class Script implements ActionChooser {
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = allowed.includes('READ_ROUTE_REFERENCE') ? 'READ_ROUTE_REFERENCE' : 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'scripted', selected, reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'odcs-'));
const writeRun = (runsDir: string, report: any) => {
  const dir = path.join(runsDir, report.runId); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine-run.json'), JSON.stringify(report));
  if (report.artifacts) fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, runId: report.runId, universeId: report.universeId, probes: report.artifacts.probes }));
};

test('GTFSAGENT, two offline passes with memory: the probed pass exports 1 relation, the reused pass omits it with its reason, valid against the official ODCS v3.1.0 schema, with provenance', async () => {
  const dir = tmp(), mem = tmp(), runs = tmp();
  try {
    const fixture = agentFixtures().find(item => item.alias === 'GTFSAGENT')!;
    const run = (id: string) => runAgent('GTFSAGENT', id, { client: fixtureClient(universeConfig('GTFSAGENT'), fixture.tables) as any, chooser: new Script(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, memory: { dir: path.join(mem, 'LOCAL-SYNTHETIC') } }) as Promise<any>;
    const first = await run('agent-gtfsagent-odcs-1'), second = await run('agent-gtfsagent-odcs-2');
    writeRun(runs, first); writeRun(runs, second);
    for (const [report, expectReuse] of [[first, false], [second, true]] as const) {
      const out = path.join(dir, `${report.runId}.odcs.yaml`);
      const result = exportOdcs({ runId: report.runId, out }, { runsDir: runs });
      if (expectReuse) { assert.equal(result.relations, 0); assert.match(result.skipped[0]!.reason, /reusada de agent-gtfsagent-odcs-1; este run no tiene sonda/); assert.deepEqual(validateAgainst(SCHEMA, parseEmittedYaml(fs.readFileSync(out, 'utf8'))), []); continue; }
      assert.equal(result.relations, 1); assert.deepEqual(result.skipped, []);
      const text = fs.readFileSync(out, 'utf8'), doc: any = parseEmittedYaml(text);
      assert.deepEqual(validateAgainst(SCHEMA, doc), []);
      assert.equal(doc.apiVersion, 'v3.1.0'); assert.equal(doc.kind, 'DataContract');
      const trips = doc.schema.find((t: any) => t.physicalName === 'gtfs_trips'), fk = trips.properties.find((p: any) => p.name === 'route_id').relationships[0];
      assert.equal(fk.type, 'foreignKey'); assert.equal(fk.to, 'routes.route_id');
      const cp = Object.fromEntries(fk.customProperties.map((p: any) => [p.property, p.value]));
      assert.equal(cp.concordiaRunId, report.runId); assert.equal(cp.concordiaVerdict, 'SOSTENIDA'); assert.equal(cp.concordiaRelationId, 'gtfsagent_trip_route');
      assert.equal(cp.concordiaReviewAuthorization.approver, 'project-owner'); assert.match(cp.concordiaReviewAuthorization.approvedAt, /^\d{4}-\d\d-\d\d$/);
      assert.match(cp.concordiaReviewAuthorization.quote, /gtfs_trips\.route_id/); assert.ok(!cp.concordiaReviewAuthorization.quote.includes('\u00c3'), 'quote repaired from double encoding');
      assert.equal(cp.concordiaEvidence.sampleBounded, true);
      if (expectReuse) assert.equal(cp.concordiaEvidence.reusedFromRun, 'agent-gtfsagent-odcs-1');
      else { assert.ok(cp.concordiaEvidence.sourceRefs.length === 2 && cp.concordiaEvidence.queries > 0); assert.ok(cp.concordiaEvidence.limitPerQuery.every((n: number) => n > 0)); }
      assert.ok(!/[A-Za-z]:[\\/]/.test(text), 'no absolute paths'); assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(text), 'no request ids');
    }
  } finally { for (const d of [dir, mem, runs]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('U1 LIVE fixture: every relation is skipped with its reason and the contract is still schema-valid', () => {
  const out = path.join(tmp(), 'u1.odcs.yaml');
  const result = exportOdcs({ runId: 'agent-u1-live-01', out }, { runsDir: path.join(ROOT, 'tests', 'fixtures', 'agent-runs') });
  assert.equal(result.relations, 0); assert.equal(result.skipped.length, 6);
  assert.ok(result.skipped.every(s => /INDETERMINADA, no SOSTENIDA \(evidence_incomplete_or_truncated\)/.test(s.reason)));
  assert.deepEqual(validateAgainst(SCHEMA, parseEmittedYaml(fs.readFileSync(out, 'utf8'))), []);
});

test('a SOSTENIDA decision whose contract is not REVIEWED is skipped; invalid or missing runs are refused; default output is next to the run', () => {
  const runs = tmp();
  try {
    writeRun(runs, { runId: 'r-pending', universeId: 'GTFSAGENT', utc: '2026-10-25T00:00:00.000Z', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', decisions: [{ relationId: 'not_in_config', verdict: 'SOSTENIDA', reasonCodes: ['bounded_sample_key_membership'] }] });
    const result = exportOdcs({ runId: 'r-pending' }, { runsDir: runs });
    assert.equal(result.relations, 0); assert.deepEqual(result.skipped.map(s => s.reason), ['sin sonda en este run: no hay contrato congelado del que tomar la revision']);
    assert.ok(fs.existsSync(path.join(runs, 'r-pending', 'contract.odcs.yaml')));
    assert.throws(() => exportOdcs({ runId: '../x' }), /INVALID_RUN_ID/);
    assert.throws(() => exportOdcs({ runId: 'nope' }, { runsDir: runs }), /AGENT_RUN_NOT_FOUND/);
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});

test('the YAML emitter round-trips through the subset parser', () => {
  const value = { a: 'x "q" ñ', b: [1, true, null, { c: [], d: {} }, [2]], 'k-1': { e: [{ f: 1, g: ['h'] }] } };
  assert.deepEqual(parseEmittedYaml(toYaml(value)), JSON.parse(JSON.stringify(value)));
});

test('the schema validator rejects what ODCS forbids (guards against a validator that accepts everything)', () => {
  const ok = { apiVersion: 'v3.1.0', kind: 'DataContract', id: 'x', version: '1', status: 'draft', schema: [{ name: 't', properties: [{ name: 'c', relationships: [{ type: 'foreignKey', to: 'u.d' }] }] }] };
  assert.deepEqual(validateAgainst(SCHEMA, ok), []);
  assert.notDeepEqual(validateAgainst(SCHEMA, { ...ok, apiVersion: 'v9' }), []);
  assert.notDeepEqual(validateAgainst(SCHEMA, { ...ok, status: undefined }), []);
  assert.notDeepEqual(validateAgainst(SCHEMA, { ...ok, schema: [{ name: 't', properties: [{ name: 'c', relationships: [{ from: 't.c', to: 'u.d' }] }] }] }), []);
  assert.notDeepEqual(validateAgainst(SCHEMA, { ...ok, schema: [{ name: 't', properties: [{ name: 'c', relationships: [{ to: 'bad ref' }] }] }] }), []);
});

const USL = path.join(ROOT, 'tests', 'fixtures', 'usl-publication');
const uslOpts = (out: string, extra: object = {}) => ({ plan: path.join(USL, 'plan.json'), run: path.join(USL, 'run'), grant: path.join(USL, 'grant.json'), out, ...extra });

test('R6-Z5: the USL dossier exports as a schema-valid ODCS contract with model, relation, provenance and neutral authorization', () => {
  const out = path.join(tmp(), 'usl.odcs.yaml');
  const result = exportUslOdcs(uslOpts(out));
  assert.equal(result.relations, 1); assert.deepEqual(result.skipped, []);
  const text = fs.readFileSync(out, 'utf8'), doc: any = parseEmittedYaml(text);
  assert.deepEqual(validateAgainst(SCHEMA, doc), []);
  const cp = Object.fromEntries(doc.customProperties.map((p: any) => [p.property, p.value]));
  assert.equal(cp.publication.namespace, 'lightning.metastore.concordia_l4_agentpub_20261025'); assert.equal(cp.publication.model, 'concordia_l4_agent_gtfs_route_v1'); assert.equal(cp.publication.relationActivated, true);
  assert.equal(cp.planProvenance.planFingerprint, '5052b6cda5f24ad1c11d9bac536b4e988d4b1e66b10364e8d1df9275aa8db3f8');
  assert.ok(cp.planProvenance.operations.some((o: any) => o.operationId === 'activate_observed_relation' && o.sqlSha256 === '9c076eef1639b00ff99750b809298d564a000656f541a55acab7884c54bfd6c4'));
  assert.equal(cp.runProvenance.runId, 'gtfs-l4-agentpub-apply-20261025-01'); assert.deepEqual(cp.runProvenance.appliedOperations, ['create_target_namespace', 'compile_versioned_model', 'activate_observed_relation']);
  assert.equal(cp.verification.state, 'verified');
  assert.equal(cp.reviewAuthorization.approver, 'project-owner'); assert.equal(cp.reviewAuthorization.planFingerprintBound, true); assert.equal(cp.reviewAuthorization.sqlHashesBound, 5);
  const model = doc.schema.find((t: any) => t.name === 'concordia_l4_agent_gtfs_route_v1');
  assert.deepEqual(model.properties.map((p: any) => p.name), ['source_key_1', 'target_key_1']); assert.equal(model.properties[0].logicalType, 'string');
  const trips = doc.schema.find((t: any) => t.name === 'gtfs_trips');
  assert.equal(trips.properties[0].relationships[0].to, 'gtfs_routes.route_id'); assert.equal(trips.properties[0].relationships[0].type, 'foreignKey');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(text), 'no request ids'); assert.ok(!/queryId|requestId|attemptRef|query_fixture/.test(text));
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), 'no absolute paths'); assert.ok(!/Jon[aá]s/.test(text), 'no personal approver');
});

test('R6-Z5: no export without authorization bound to the plan, or without a verified run', () => {
  const dir = tmp();
  try {
    const bad = path.join(dir, 'grant.json'); fs.writeFileSync(bad, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(USL, 'grant.json'), 'utf8')), planFingerprint: 'x'.repeat(64) }));
    assert.match(exportUslOdcs(uslOpts(path.join(dir, 'a.yaml'), { grant: bad })).skipped[0]!.reason, /no corresponde/);
    const none = exportUslOdcs(uslOpts(path.join(dir, 'b.yaml'), { grant: undefined }));
    assert.equal(none.relations, 0); assert.match(none.skipped[0]!.reason, /sin autorizacion/);
    const half = path.join(dir, 'run'); fs.mkdirSync(half);
    fs.writeFileSync(path.join(half, 'journal.jsonl'), fs.readFileSync(path.join(USL, 'run', 'journal.jsonl'), 'utf8').split('\n').filter(l => l && !l.includes('"state":"verified"')).join('\n') + '\n');
    assert.match(exportUslOdcs(uslOpts(path.join(dir, 'c.yaml'), { run: half })).skipped[0]!.reason, /no esta verificado/);
    assert.match(exportUslOdcs(uslOpts(path.join(dir, 'd.yaml'), { run: undefined })).skipped[0]!.reason, /sin run/);
    assert.deepEqual(validateAgainst(SCHEMA, parseEmittedYaml(fs.readFileSync(path.join(dir, 'c.yaml'), 'utf8'))), []);
    assert.throws(() => exportUslOdcs({ plan: path.join(dir, 'missing.json') }), /USL_PLAN_NOT_FOUND/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G0-8: review comes from the contract frozen in the run probe; reused-without-probe is omitted with its own reason; unreadable config fails loudly', () => {
  const runs = tmp();
  try {
    const probe = (state: string) => ({ relationId: 'gtfsagent_trip_route', evidence: { relationContract: { reviewState: state } } });
    const decision = { relationId: 'gtfsagent_trip_route', verdict: 'SOSTENIDA', reasonCodes: ['bounded_sample_key_membership'] };
    const base = { universeId: 'GTFSAGENT', utc: '2026-10-25T00:00:00.000Z', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' };
    writeRun(runs, { ...base, runId: 'r-frozen-pending', decisions: [decision], artifacts: { probes: [probe('PENDING')] } });
    assert.deepEqual(exportOdcs({ runId: 'r-frozen-pending' }, { runsDir: runs }).skipped.map(s => s.reason), ['contrato congelado PENDING, no REVIEWED']);
    writeRun(runs, { ...base, runId: 'r-reused', decisions: [{ ...decision, reused: { fromRunId: 'agent-earlier' } }] });
    const reused = exportOdcs({ runId: 'r-reused' }, { runsDir: runs });
    assert.equal(reused.relations, 0); assert.match(reused.skipped[0]!.reason, /reusada de agent-earlier; este run no tiene sonda/);
    writeRun(runs, { ...base, runId: 'r-badcfg', universeId: 'NO_SUCH_UNIVERSE', decisions: [decision] });
    assert.throws(() => exportOdcs({ runId: 'r-badcfg' }, { runsDir: runs }), /ODCS_UNIVERSE_CONFIG_UNREADABLE/);
  } finally { fs.rmSync(runs, { recursive: true, force: true }); }
});

test('the review authorization is read from the probe frozen in the run, never from the current config; an old run without it omits the relation', async () => {
  const runs = tmp(), dir = tmp();
  try {
    const fixture = agentFixtures().find(item => item.alias === 'GTFSAGENT')!;
    const report: any = await runAgent('GTFSAGENT', 'agent-gtfsagent-frozen-1', { client: fixtureClient(universeConfig('GTFSAGENT'), fixture.tables) as any, chooser: new Script(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, memory: { dir: path.join(dir, 'mem') } });
    const frozen = { approver: 'frozen-approver', approvedAt: '2026-01-02', quote: 'cita congelada en la sonda' };
    const copy = (runId: string) => ({ ...JSON.parse(JSON.stringify(report)), runId, artifacts: { probes: JSON.parse(JSON.stringify(report.artifacts.probes)) } });
    const withAuth = copy(report.runId); for (const p of withAuth.artifacts.probes) p.evidence.reviewAuthorization = frozen;
    writeRun(runs, withAuth);
    const ok = exportOdcs({ runId: report.runId, out: path.join(dir, 'a.yaml') }, { runsDir: runs });
    assert.equal(ok.relations, 1);
    const cp = Object.fromEntries((parseEmittedYaml(fs.readFileSync(path.join(dir, 'a.yaml'), 'utf8')) as any).schema.flatMap((t: any) => t.properties).flatMap((p: any) => p.relationships ?? []).flatMap((r: any) => r.customProperties).map((p: any) => [p.property, p.value]));
    assert.equal(cp.concordiaReviewAuthorization.approver, 'project-owner', 'the approver name never leaves in a public export'); assert.ok(!fs.readFileSync(path.join(dir, 'a.yaml'), 'utf8').includes('frozen-approver')); assert.equal(cp.concordiaReviewAuthorization.quote, 'cita congelada en la sonda');
    const old = copy('agent-gtfsagent-frozen-old');
    for (const p of old.artifacts.probes) { delete p.evidence.reviewAuthorization; if (p.evidence.relation) delete p.evidence.relation.reviewAuthorization; }
    writeRun(runs, old);
    const none = exportOdcs({ runId: old.runId, out: path.join(dir, 'b.yaml') }, { runsDir: runs });
    assert.equal(none.relations, 0); assert.deepEqual(none.skipped.map(s => s.reason), ['reviewAuthorization no congelada en este run']);
    assert.deepEqual(validateAgainst(SCHEMA, parseEmittedYaml(fs.readFileSync(path.join(dir, 'b.yaml'), 'utf8'))), []);
  } finally { for (const d of [runs, dir]) fs.rmSync(d, { recursive: true, force: true }); }
});
