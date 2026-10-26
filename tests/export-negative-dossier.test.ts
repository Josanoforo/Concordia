import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { buildNegativeDossier, exportNegativeDossier, renderNegativeDossierMarkdown, NA } from '../src/export/negative-dossier.ts';

const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'agent-runs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'negdossier-'));

test('M4-2: U1 live fixture catalogs the 6 sample-cap INDETERMINADA, the label trap with its counterfactual, and the unexecutable COMA proposal', () => {
  const out = tmp();
  const r = exportNegativeDossier({ runId: 'agent-u1-live-01', out, runsDir: FIXTURES });
  const written = path.join(out, 'negative-dossier.json'), rel = path.relative(ROOT, written);
  assert.equal(r.path, rel.startsWith('..') || path.isAbsolute(rel) ? written : rel.split(path.sep).join('/'), 'relative to the repo when inside it, absolute otherwise');
  const d = JSON.parse(fs.readFileSync(written, 'utf8'));
  const inside = exportNegativeDossier({ runId: 'agent-u2-live-02', out: path.join(ROOT, '.concordia', 'tmp', 'nd-rel'), runsDir: FIXTURES });
  assert.equal(inside.path, '.concordia/tmp/nd-rel/negative-dossier.json', 'inside the repo the path is relative with forward slashes');
  fs.rmSync(path.join(ROOT, '.concordia', 'tmp', 'nd-rel'), { recursive: true, force: true });
  assert.deepEqual(r.byKind, { INDETERMINATE: 5, LABEL_CONFLICT_OBSERVED: 1, COMA_OUT_OF_SCOPE_NOT_EXECUTABLE: 6 });
  assert.equal(r.entries, 12);
  assert.equal(d.entries.filter((e: any) => e.incompleteness !== NA && e.incompleteness.kind === 'EXPECTED_SAMPLE_CAP').length, 6);
  assert.ok(d.entries.every((e: any) => e.provenance.runId === 'agent-u1-live-01'));
  const trap = d.entries.find((e: any) => e.pair.id === 'taxi_zones_zones_trap');
  assert.equal(trap.kind, 'LABEL_CONFLICT_OBSERVED');
  assert.equal(trap.verdict, 'INDETERMINADA');
  assert.equal(trap.evidence.keyOverlap.text, '20 de 20');
  assert.equal(trap.evidence.labelAgreement.text, '0 de 50');
  assert.equal(trap.evidence.rowsRead.from, 50);
  assert.deepEqual(trap.evidence.sampleQualitySignals.includes('LABEL_CONFLICT'), true);
  assert.equal(trap.declaredInConfig.kind, NA, 'the trap is not declared with a kind/space in the config: nothing is invented');
  assert.match(trap.declaredInConfig.reason, /share key values but not zone names/);
  assert.match(trap.counterfactual, /tope 50/);
  assert.match(trap.counterfactual, /umbral sostenido 0\.8/);
  assert.equal(trap.critic.perRelation, NA, 'the run has no per-relation critic result');
  const coma = d.entries.filter((e: any) => e.kind === 'COMA_OUT_OF_SCOPE_NOT_EXECUTABLE');
  assert.ok(coma.length >= 1);
  assert.ok(coma.some((e: any) => e.evidence.coverageProbeReason === 'NO_SAFE_SAMPLED_VALUES'));
  assert.ok(coma.every((e: any) => /NO VERIFICADO/.test(e.verdict)));
  const md = fs.readFileSync(path.join(out, 'negative-dossier.md'), 'utf8');
  assert.match(md, /taxi_zones_zones_trap · LABEL_CONFLICT_OBSERVED/);
  assert.match(md, /etiquetas: 0 de 50/);
});

test('M4-2: U2 fixture (no bundle for some pairs) keeps unavailable data as "no disponible"', () => {
  const out = tmp();
  const r = exportNegativeDossier({ runId: 'agent-u2-live-02', out, runsDir: FIXTURES });
  const d = JSON.parse(fs.readFileSync(path.resolve(ROOT, r.path), 'utf8'));
  assert.ok(r.entries >= 1);
  const entry = d.entries.find((e: any) => e.kind === 'COMA_OUT_OF_SCOPE_NOT_EXECUTABLE');
  assert.equal(entry.evidence.coverageProbeReason, 'ENDPOINT_OUTSIDE_ALLOWLIST_OR_UNDISCOVERED');
  assert.equal(entry.declaredInConfig.config, NA);
  assert.throws(() => exportNegativeDossier({ runId: '../x', runsDir: FIXTURES }), /NEGATIVE_DOSSIER_INVALID_RUN_ID/);
  assert.throws(() => exportNegativeDossier({ runId: 'agent-missing-run', runsDir: FIXTURES }), /NEGATIVE_DOSSIER_RUN_NOT_FOUND/);
});

const TABLES: Record<string, { columns: string[]; rows: string[][] }> = {
  orders: { columns: ['order_id', 'customer_id', 'region_code'], rows: [['o1', 'c1', 'r1'], ['o2', 'c2', 'r1'], ['o3', 'c1', 'r2']] },
  customers: { columns: ['customer_id', 'customer_name', 'segment_code'], rows: [['c1', 'Ana', 's1'], ['c2', 'Beto', 's2'], ['c9', 'Extra', 's3']] },
  regions: { columns: ['region_code', 'region_name'], rows: [['r1', 'North'], ['r2', 'South'], ['r7', 'Unused']] }
};
function fakeClient() {
  let n = 0;
  return {
    async describe(_db: string, table: string) { return { rows: TABLES[table].columns.map(column => [column, 'string']), requestId: `fake-describe-${table}` }; },
    async runSql(sql: string, limit = 20) {
      const table = Object.keys(TABLES).find(name => new RegExp(`\\b${name}\\b`).test(sql))!;
      const select = /^SELECT (.+?) FROM /s.exec(sql)![1].split(',').map(item => item.trim().replace(/`/g, ''));
      const meta = TABLES[table];
      let rows = meta.rows;
      const include = /(\w+)`? IN \(([^)]*)\)/.exec(sql);
      if (include) { const col = meta.columns.indexOf(include[1].replace(/`/g, '')), values = [...include[2].matchAll(/'([^']*)'/g)].map(item => item[1]); rows = rows.filter(row => values.includes(row[col])); }
      n++;
      return { sql, requestId: `fake-req-${n}`, queryId: `fake-q-${n}`, rows: rows.slice(0, limit).map(row => select.map(column => row[meta.columns.indexOf(column)])), durationMs: 0, utc: '2026-10-24T00:00:00.000Z' };
    }
  };
}
class Scripted implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = this.script.shift() ?? 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: allowed.includes(selected) ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: allowed.includes(selected) ? selected : undefined, reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}

test('M4-2: AGENTFX offline run produces entries whose provenance and denominators come from the run itself', async () => {
  const report = await runAgent('AGENTFX', 'agent-agentfx-negdossier-1', { client: fakeClient() as any, chooser: new Scripted(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE']), executionMode: 'LOCAL', persist: false, now: () => '2026-10-24T00:00:00.000Z' });
  const d = buildNegativeDossier({ run: report, artifacts: (report as any).artifacts ? { probes: (report as any).artifacts.probes } : undefined });
  assert.equal(d.runId, 'agent-agentfx-negdossier-1');
  assert.ok(d.entries.every(e => e.provenance.runId === d.runId && e.provenance.dataOrigin === 'SYNTHETIC'));
  const counted = Object.values(d.byKind).reduce((a, b) => a + b, 0);
  assert.equal(counted, d.entries.length);
  // Nothing positive leaks in: every probe entry is a non-SOSTENIDA verdict or an observed label conflict.
  assert.ok(d.entries.every(e => e.verdict !== 'SOSTENIDA'));
  // Without a config file every declaredInConfig is NA rather than invented.
  assert.ok(d.entries.filter(e => e.kind !== 'COMA_OUT_OF_SCOPE_NOT_EXECUTABLE').every(e => (e.declaredInConfig as any).config === NA));
  assert.ok(d.entries.every(e => e.counterfactual.length > 0));
});

test('G1: demonstrated contradictions are separated from not-established ones; mode/origin at the root and header; unresolved inputs are warned, not swallowed', () => {
  const out = tmp();
  exportNegativeDossier({ runId: 'agent-u1-live-01', out, runsDir: FIXTURES });
  const u1 = JSON.parse(fs.readFileSync(path.join(out, 'negative-dossier.json'), 'utf8'));
  assert.deepEqual(u1.byClass, { DEMONSTRATED: 0, NOT_ESTABLISHED: 12 }, 'U1 has only INDETERMINADA, a label conflict without verdict and unexecutable COMA proposals');
  assert.ok(typeof u1.executionMode === 'string' && typeof u1.dataOrigin === 'string' && u1.executionMode !== '');
  const probe = (id: string, verdict: string, reasonCodes: string[]) => ({ relationId: id, verdict, from: { db: 'D', table: 'a', column: 'x' }, to: { db: 'D', table: 'b', column: 'y' }, evidence: { overlap: { probed: 10, matched: 1 }, decision: { verdict, reasonCodes } } });
  const run = { runId: 'r-syn', universeId: 'U', utc: '2026-10-26T00:00:00Z' };
  const d = buildNegativeDossier({ run, artifacts: { probes: [probe('p_mis', 'ENGAÑOSA', ['low_overlap']), probe('p_ns', 'SOSTENIDA', ['incompatible_namespaces']), probe('p_ind', 'INDETERMINADA', ['no_signal'])] }, warnings: ['config del universo ilegible (Error): x'] });
  assert.deepEqual(d.entries.map(e => [e.pair.id, e.class]), [['p_ind', 'NOT_ESTABLISHED'], ['p_mis', 'DEMONSTRATED'], ['p_ns', 'DEMONSTRATED']]);
  assert.equal(d.executionMode, 'UNKNOWN'); assert.equal(d.dataOrigin, 'UNKNOWN'); assert.equal(d.entries[0]!.provenance.executionMode, 'UNKNOWN');
  assert.deepEqual(d.byClass, { DEMONSTRATED: 2, NOT_ESTABLISHED: 1 }); assert.equal(d.warnings.length, 1);
  const md = renderNegativeDossierMarkdown(d);
  assert.match(md, /Modo de ejecucion: UNKNOWN; origen de datos: UNKNOWN/); assert.match(md, /Demostradas por muestra acotada: 2 de 3; no establecidas .*: 1 de 3/);
  assert.match(md, /- Aviso: config del universo ilegible/);
  assert.ok(md.indexOf('# Demostrado') < md.indexOf('p_mis') && md.indexOf('p_mis') < md.indexOf('# No establecido') && md.indexOf('# No establecido') < md.indexOf('p_ind'));
});

test('RC-20/RC-10: a label conflict with an unavailable verdict is NOT_ESTABLISHED; unknown modes and origins are UNKNOWN', () => {
  const conflict = (verdict?: string) => ({ relationId: 'p_lc', ...(verdict ? { verdict } : {}), from: { db: 'D', table: 'a', column: 'x' }, to: { db: 'D', table: 'b', column: 'y' }, evidence: { overlap: { probed: 10, matched: 9 }, typedEvidence: { observations: [{ type: 'SAMPLE_QUALITY', measuredTuples: [['LABEL_CONFLICT']] }] } } });
  const cls = (v?: string) => buildNegativeDossier({ run: { runId: 'r' }, artifacts: { probes: [conflict(v)] } }).entries[0]!;
  assert.equal(cls().verdict, NA); assert.equal(cls().class, 'NOT_ESTABLISHED');
  assert.equal(cls('INDETERMINADA').class, 'NOT_ESTABLISHED'); assert.equal(cls('SOSTENIDA').class, 'DEMONSTRATED');
  const d = buildNegativeDossier({ run: { runId: 'r', executionMode: 'FOO', dataOrigin: 'BAR' }, artifacts: { probes: [conflict('ENGAÑOSA')] } });
  assert.equal(d.executionMode, 'UNKNOWN'); assert.equal(d.dataOrigin, 'UNKNOWN'); assert.equal(d.entries[0]!.provenance.executionMode, 'UNKNOWN');
  const ok = buildNegativeDossier({ run: { runId: 'r', executionMode: 'REPLAY', dataOrigin: 'SYNTHETIC' } });
  assert.equal(ok.executionMode, 'REPLAY'); assert.equal(ok.dataOrigin, 'SYNTHETIC');
});

test('A40: the negative dossier carries the repeated target key as a DEMONSTRATED data-quality entry, one per column', () => {
  const run = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'agent-tpcds-live-04', 'engine-run.json'), 'utf8'));
  const d = buildNegativeDossier({ run });
  const dq = d.entries.filter(e => e.kind === 'DATA_QUALITY_TARGET_NOT_UNIQUE');
  assert.equal(dq.length, 1); assert.equal(dq[0]!.class, 'DEMONSTRATED'); assert.equal(dq[0]!.pair.to, 'TPCDS_DB.catalog_page.cp_catalog_page_sk');
  assert.equal((dq[0]!.evidence as any).probesObserving, 2); assert.equal((dq[0]!.evidence as any).duplicateKeyCount, 2);
  assert.match(dq[0]!.counterfactual, /no se comporta como clave unica/);
  assert.match(renderNegativeDossierMarkdown(d), /Hallazgo de calidad de datos: TPCDS_DB\.catalog_page\.cp_catalog_page_sk repite claves \(2 claves repetidas, hasta 2 filas por clave, 20 filas leidas; observada en 2 sondas/);
  assert.equal(d.executionMode, 'LIVE'); assert.equal(d.dataOrigin, 'PUBLIC');
});

test('N73: the dossier declares schemaVersion 2 (class, byClass, warnings, root mode/origin and the data-quality kind are new since version 1)', () => {
  const d = buildNegativeDossier({ run: { runId: 'r' } });
  assert.equal(d.schemaVersion, 2); assert.deepEqual(d.byClass, { DEMONSTRATED: 0, NOT_ESTABLISHED: 0 }); assert.deepEqual(d.warnings, []);
  const out = tmp();
  exportNegativeDossier({ runId: 'agent-u2-live-02', out, runsDir: FIXTURES });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'negative-dossier.json'), 'utf8')).schemaVersion, 2);
});

test('data-quality findings come from the source run when the closed run did not measure them, and the approver name is not published', () => {
  const dup = (id: string) => ({ proposalId: id, from: { db: 'D', table: 'f', column: 'a' }, to: { db: 'D', table: 'catalog_page', column: 'cp_sk' }, coverageProbe: { status: 'EXECUTED', diagnostic: { keyRules: { targetUniqueness: { status: 'DUPLICATES_OBSERVED', rows: 20, duplicateKeyCount: 2, maxRowsPerKey: 2 } }, multiplicity: { to: { duplicateKeys: [{ key: '9' }] } } } } });
  const base = { runId: 'agent-closed', universeId: 'U', executionMode: 'LIVE', dataOrigin: 'PUBLIC', decisions: [], reviewOverlay: { origin: 'HUMAN_REVIEW', sha256: 'a'.repeat(64), approval: { approver: 'Nombre Persona', approvedAt: '2026-10-25', quote: 'ok', session: 's', package: 'p.md' }, deferred: [] } };
  const d = buildNegativeDossier({ run: base, qualityRuns: [{ runId: 'agent-source', run: { postComa: { proposals: [dup('p1'), dup('p2')] } } }] });
  const dq = d.entries.filter(e => e.kind === 'DATA_QUALITY_TARGET_NOT_UNIQUE');
  assert.equal(dq.length, 1); assert.equal((dq[0]!.evidence as any).observedInRun, 'agent-source'); assert.equal((dq[0]!.evidence as any).probesObserving, 2);
  const md = renderNegativeDossierMarkdown(d);
  assert.match(md, /medido en el run fuente agent-source, no en este/); assert.ok(!/Nombre Persona/.test(JSON.stringify(d) + md), 'no operator name');
});
