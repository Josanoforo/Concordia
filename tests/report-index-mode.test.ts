import test from 'node:test';
import assert from 'node:assert/strict';
import { modeLabel, reportHtml } from '../src/report/index.ts';

test('G0-7: the mode label derives from executionMode and dataOrigin; unknown is UNKNOWN, never LIVE', () => {
  assert.match(modeLabel({ utc: '2026-10-26T00:00:00Z' }), /^UNKNOWN \(modo de ejecucion no registrado en el run\); origen de datos: UNKNOWN/);
  assert.match(modeLabel({ executionMode: 'LIVE', dataOrigin: 'PUBLIC', utc: '2026-10-26T00:00:00Z' }), /^LIVE 2026-10-26T00:00:00Z; origen de datos: PUBLIC/);
  assert.match(modeLabel({ executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' }), /^LOCAL .*origen de datos: SYNTHETIC/);
  assert.doesNotMatch(modeLabel({ executionMode: 'live' }), /^LIVE/);
  const bundle = { sourceUtc: '2026-01-01', artifacts: { discovery: { tables: {} }, relaciones: { relations: [] }, fichas: { fichas: [] }, eval: {}, 'usl-demo': {} }, ledger: [], receipts: [] };
  const html = reportHtml('U1', { runId: 'r', utc: '2026-10-26T00:00:00Z' }, bundle);
  assert.match(html, /class="banner">UNKNOWN /); assert.doesNotMatch(html, /class="banner">LIVE/);
  assert.match(reportHtml('U1', { runId: 'r', executionMode: 'LIVE', dataOrigin: 'PUBLIC', utc: 'T' }, bundle), /class="banner">LIVE T; origen de datos: PUBLIC/);
});

test('G1: fixed claims in the HTML are derived from the data (receipts, warm reuse)', () => {
  const art = { discovery: { tables: {} }, relaciones: { relations: [] }, fichas: { fichas: [] }, eval: {}, 'usl-demo': {} };
  const none = reportHtml('U1', { runId: 'r', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' }, { sourceUtc: 'T', artifacts: art, ledger: [], receipts: [] });
  assert.match(none, /Este bundle no trae recibos\./); assert.doesNotMatch(none, /Opus|Reutilización verificada/);
  const some = reportHtml('U1', { runId: 'r', mode: 'warm', executionMode: 'LIVE', dataOrigin: 'PUBLIC', utc: 'T' }, { sourceUtc: 'T', artifacts: art, ledger: [], receipts: [{ utc: 'T', receiptId: 'rc1', status: 'rejected' }, { utc: 'T', receiptId: 'rc2' }] });
  assert.match(some, /Se listan 2 recibos históricos \(estados originales: rejected, historical\)/); assert.match(some, /Corrida warm: reutiliza decisiones/);
});

test('RC-10: modeLabel validates mode and origin against the canonical values', () => {
  assert.match(modeLabel({ executionMode: 'FOO', dataOrigin: 'BAR', utc: 'T' }), /^UNKNOWN .*origen de datos: UNKNOWN/);
  assert.match(modeLabel({ executionMode: 'LIVE', dataOrigin: 'BAR', utc: 'T' }), /^LIVE T; origen de datos: UNKNOWN/);
  assert.match(modeLabel({ executionMode: 'LOCAL', dataOrigin: { label: 'MIXED' } }), /origen de datos: MIXED/);
});

test('writeReport HTML does not leak local paths and keeps URLs (shared scrub)', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), { ROOT } = await import('../src/runtime.ts');
  const { writeReport, scrub } = await import('../src/report/index.ts');
  const id = 'scrub-writereport-test', dir = path.join(ROOT, 'out', id);
  const bundle = { sourceUtc: 'T', artifacts: { discovery: { tables: {} }, relaciones: { relations: [] }, fichas: { fichas: [] }, eval: {}, 'usl-demo': { note: 'C:\\\\Users\\\\jon\\\\x.txt /c/Users/jon/y file:///C:/Users/jon/z https://example.org/ok' } }, ledger: [{ p: '/home/jon/l.json' }], receipts: [] };
  try {
    const rel = writeReport(id, { runId: 'r', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', note: '\\\\fileserver\\share\\jon\\f' }, bundle);
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!html.includes('jon') && !html.includes('fileserver'), 'no local path survives');
    assert.match(html, /https:\/\/example\.org\/ok/); assert.match(html, /\[ruta local\]/);
    assert.equal(scrub('ver https://a.test/x'), 'ver https://a.test/x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
