import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertLegacyMutationSql, assertReadPathSql, assertRunSqlAllowed, redactSqlForTrace, Zetaris } from '../src/clients/zetaris.ts';
import { demoUsl } from '../src/usl/demo.ts';
import { buildCompleteUsl } from '../src/usl/complete.ts';
import { ROOT, readJson, SafeError, setTraceRun } from '../src/runtime.ts';

// N72: every trace event this file writes carries run=synthetic-... so it can never be read as live evidence in evidence/trace.jsonl.
const SYNTHETIC_RUN = 'synthetic-zetaris-read-path-test';
before(() => setTraceRun(SYNTHETIC_RUN));
after(() => setTraceRun());

const MUTATIONS = ['CREATE LIGHTNING DATABASE d DESCRIBE BY "x"', 'create table t (a int)', 'DROP TABLE d.t', 'ALTER TABLE d.t ADD COLUMN c int', 'INSERT INTO d.t VALUES (1)', 'UPDATE d.t SET a = 1',
  'DELETE FROM d.t', 'TRUNCATE TABLE d.t', 'MERGE INTO d.t USING s ON 1=1', 'GRANT ALL ON d.t TO u', 'COMPILE USL m DEPLOY NAMESPACE n DDL x', 'ACTIVATE USL TABLE m.t AS v', 'CREATE NAMESPACE IF NOT EXISTS n',
  'SELECT 1; DROP TABLE d.t', 'WITH x AS (SELECT 1) DELETE FROM d.t', '  \n drop table d.t', '/* hi */ DROP TABLE d.t', '', 'LOAD USL m NAMESPACE n; DROP TABLE d.t', 'LOAD USL m; ACTIVATE USL TABLE m.t AS v'];
const READS = ['SELECT a FROM d.t LIMIT 5', '  select a from d.t LIMIT 1;', 'DESCRIBE DATASOURCE TABLE d.t', 'SHOW LIGHTNING TABLES d', 'WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'LOAD USL model_1 NAMESPACE lightning.metastore.ns',
  'LOAD USL model_1'];

test('R6-S1: every mutation is refused by the read path allowlist, every current read shape and LOAD USL pass', () => {
  for (const sql of MUTATIONS) assert.throws(() => assertReadPathSql(sql), /READ_PATH_MUTATION_FORBIDDEN/, sql);
  for (const sql of READS) assert.doesNotThrow(() => assertReadPathSql(sql), sql);
});

test('R6-S1: Zetaris.runSql refuses mutations before sending; the legacy method sends the same statement and keeps the JOIN guard', async () => {
  const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' }), prior = globalThis.fetch, sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body).sql); return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
  try {
    for (const sql of MUTATIONS.slice(0, 6)) await assert.rejects(client.runSql(sql, 1), /READ_PATH_MUTATION_FORBIDDEN/);
    await assert.rejects(client.runSql('SELECT a FROM d.t JOIN e', 1), /FORBIDDEN_SQL/);
    assert.equal(sent.length, 0, 'nothing reached the transport');
    await client.runSql('SELECT a FROM d.t LIMIT 1', 1); await client.runSql('LOAD USL m NAMESPACE n', 1);
    assert.equal(sent.length, 2);
    await client.runLegacyMutationSql('CREATE LIGHTNING DATABASE d DESCRIBE BY "x"', 1, { caller: 'decisions' });
    assert.equal(sent.at(-1), 'CREATE LIGHTNING DATABASE d DESCRIBE BY "x"');
    await assert.rejects(client.runLegacyMutationSql('SELECT a FROM d.t JOIN e', 1, { caller: 'decisions' }), /FORBIDDEN_SQL/);
  } finally { globalThis.fetch = prior; }
});

test('R6-S1: the legacy USL demo sends creates/compiles/activations through the explicit method and reads through runSql', async t => {
  const fixture = readJson<any>('output_examples/sample-fixture/U1.json'), plan = buildCompleteUsl('U1', fixture.relations);
  const relationsPath = path.join(ROOT, 'out/U1/relaciones.json'), previous = fs.existsSync(relationsPath) ? fs.readFileSync(relationsPath) : null;
  fs.mkdirSync(path.dirname(relationsPath), { recursive: true }); fs.writeFileSync(relationsPath, JSON.stringify({ relations: fixture.relations }));
  t.after(() => { if (previous !== null) fs.writeFileSync(relationsPath, previous); else fs.rmSync(relationsPath, { force: true }); });
  const reads: string[] = [], mutations: string[] = [], response = (sql: string, rows: any[][]) => ({ sql, rows, utc: '2026-01-01', requestId: 's', queryId: 's', durationMs: 1 });
  const client = { runSql: async (sql: string) => { assertReadPathSql(sql); reads.push(sql); if (sql.startsWith('LOAD')) throw new SafeError('ZETARIS_APPLICATION_ERROR', undefined, 'USL model does not exist'); return response(sql, [['x']]); },
    runLegacyMutationSql: async (sql: string) => { mutations.push(sql); return response(sql, [['x']]); } };
  await demoUsl('U1', client as any);
  assert.ok(reads.every(sql => /^(SELECT|LOAD USL)/.test(sql)), 'only reads and LOAD USL used runSql');
  assert.ok(mutations.some(sql => /^COMPILE USL/.test(sql)) && mutations.every(sql => /^(CREATE|COMPILE|ACTIVATE)/.test(sql)));
  assert.ok(plan.plans.length > 0);
});

test('R6-S1: no source file sends a mutation literal through runSql (all callers audited)', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.ts')) fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/\.runSql\(/.test(line) && /`(?:CREATE|COMPILE USL|ACTIVATE USL|DROP|ALTER|INSERT|UPDATE|DELETE)\b/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`); }); } };
  walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});

test('G0-1: a WITH whose main statement mutates is refused; nested legitimate CTEs pass', () => {
  const refused = ['WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a', 'WITH a AS (SELECT 1) DELETE FROM t', 'WITH a AS (SELECT 1) UPDATE t SET x = 1', 'WITH a AS (SELECT 1) MERGE INTO t USING a ON 1=1',
    'WITH a AS (SELECT 1) INSERT INTO t SELECT 1 /* ) SELECT */', "WITH a AS (SELECT 1) INSERT INTO t VALUES (') SELECT')", 'WITH a AS (DELETE FROM t RETURNING 1) SELECT * FROM a',
    'WITH a AS (SELECT 1 SELECT 2', 'SELECT 1 -- x\n; DROP TABLE t', "SELECT 'unterminated", 'WITH RECURSIVE a AS (SELECT 1) CREATE TABLE t AS SELECT * FROM a', 'SELECT (1', 'WITH a AS SELECT 1 SELECT 2'];
  for (const sql of refused) assert.throws(() => assertReadPathSql(sql), /READ_PATH_MUTATION_FORBIDDEN/, sql);
  const allowed = ['WITH a AS (SELECT 1 AS x), b AS (WITH c AS (SELECT x FROM a) SELECT x FROM c) SELECT x FROM b', "WITH a (x) AS (SELECT 'DELETE FROM t') SELECT x FROM a", 'WITH RECURSIVE a AS (SELECT 1) SELECT * FROM a',
    "SELECT 'a;b' AS s FROM d.t", 'LIST DQ USL lightning.metastore.concordia_u1.u1_usl'];
  for (const sql of allowed) assert.doesNotThrow(() => assertReadPathSql(sql), sql);
});

test('CR-1: the read path is fail-closed on anything the backend could parse differently (comments, control characters, backslash literals, chains)', () => {
  const cr = String.fromCharCode(13);
  const refused = [
    `SELECT 1 --${cr}; DROP TABLE t`, `SELECT 1 -- x${cr}DROP TABLE t`, 'SELECT 1 /* /* */ ; DROP TABLE t; /* */ */', 'SELECT 1 /* a /* b /* c */ */ */ ; DROP TABLE t',
    'SELECT 1 -- x\nFROM t', 'SELECT 1 FROM t --', 'SELECT 1 /* open', 'SELECT 1 /**/ FROM t', 'SELECT 1 */ FROM t', `SELECT 1${cr}FROM t`, 'SELECT 1\u0000FROM t', 'SELECT 1\u000bFROM t', 'SELECT 1 FROM t', 'SELECT 1\u0085FROM t',
    "SELECT 'a\\' FROM t; DROP TABLE t; --'", "SELECT 'a\\'b' FROM t", 'SELECT 1; SELECT 2', 'SELECT 1;;', 'SELECT 1; ;', 'LOAD USL m -- c', 'SHOW LIGHTNING TABLES d /* c */'];
  for (const sql of refused) assert.throws(() => assertReadPathSql(sql), /READ_PATH_MUTATION_FORBIDDEN/, JSON.stringify(sql));
  const allowed = ['SELECT 1\nFROM t', 'SELECT\ta FROM d.t LIMIT 3;', "SELECT 'a--b' AS s FROM d.t", "SELECT '/* x */' AS s FROM d.t", "SELECT 'a;b' FROM d.t;", 'SELECT "a-b" FROM d.t LIMIT 1',
    "SELECT 'it''s' FROM d.t", 'WITH a AS (SELECT 1 AS x)\nSELECT x FROM a', 'DESCRIBE DATASOURCE TABLE d.t', 'SHOW LIGHTNING DATABASES', 'LOAD USL m NAMESPACE lightning.metastore.n'];
  for (const sql of allowed) assert.doesNotThrow(() => assertReadPathSql(sql), JSON.stringify(sql));
});

test('CR-1: the non-COMPILE legacy forms use the same lexical rule', () => {
  const cr = String.fromCharCode(13);
  for (const [sql, caller] of [[`CREATE NAMESPACE IF NOT EXISTS n -- x${cr}`, 'usl-complete'], ['CREATE NAMESPACE IF NOT EXISTS n /* c */', 'usl-complete'], ['LOAD USL m /* /* */ ; DROP TABLE t */', 'usl-resume'],
    ['ACTIVATE USL TABLE m.t AS SELECT a FROM x -- c', 'usl-resume'], [`ACTIVATE USL TABLE m.t AS SELECT a FROM x${cr}`, 'usl-index'], ["ACTIVATE USL TABLE m.t AS SELECT 'a\\' FROM x", 'usl-index'],
    ['CREATE LIGHTNING DATABASE d DESCRIBE BY "x" -- c', 'decisions']] as [string, any][])
    assert.throws(() => assertLegacyMutationSql(sql, caller), /LEGACY_MUTATION_NOT_ALLOWED/, `${caller}: ${JSON.stringify(sql)}`);
  assert.doesNotThrow(() => assertLegacyMutationSql("ACTIVATE USL TABLE m.t AS SELECT 'a--b' AS c FROM x", 'usl-index'));
});

test('CR-2: UPDATE USL has no legacy form for any caller (it replaces a published model; only the authorized publication path may send it)', () => {
  const sqls = ['UPDATE USL u1_usl NAMESPACE lightning.metastore.concordia_u1 AS {"name":"u1_usl","tables":[]}', 'UPDATE USL m NAMESPACE n AS {}', 'UPDATE d.t SET a = 1', 'UPDATE USL m NAMESPACE n AS {"a":1}; DROP TABLE t'];
  for (const caller of ['usl-complete', 'usl-index', 'usl-resume', 'usl-demo', 'decisions', 'register', 'register-madi', 'register-madi-domains'])
    for (const sql of sqls) assert.throws(() => assertLegacyMutationSql(sql, caller), /LEGACY_MUTATION_NOT_ALLOWED/, `${caller}: ${sql}`);
  assert.throws(() => assertReadPathSql(sqls[0]), /READ_PATH_MUTATION_FORBIDDEN/);
});

test('CR-1: the agent SQL templates never emit comments, control characters or backslashes (source scan)', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.ts')) fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/`\s*(?:SELECT|WITH|DESCRIBE|SHOW)\b[^`]*(?:--|\/\*)/.test(line) || /'\s*(?:SELECT|WITH)\b[^']*(?:--|\/\*)/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`); }); } };
  walk(path.join(ROOT, 'src/agent'));
  assert.deepEqual(offenders, []);
});

test('G0-2: the legacy method accepts only each caller closed forms, traces the full SQL and has no runSql fallback', async () => {
  const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' }), prior = globalThis.fetch, sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body).sql); return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
  const traceFile = path.join(ROOT, 'evidence/trace.jsonl'), before = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').length : 0;
  try {
    const bad: [string, any][] = [['DROP NAMESPACE x', 'usl-complete'], ['UPDATE USL m NAMESPACE n AS {}', 'usl-complete'], ['ALTER TABLE d.t ADD COLUMN c int', 'decisions'], ['INSERT INTO d.t VALUES (1)', 'register'],
      ['CREATE NAMESPACE IF NOT EXISTS n; DROP NAMESPACE n', 'usl-index'], ['ACTIVATE USL TABLE m.t AS SELECT a FROM x; DROP TABLE y', 'usl-resume'], ['CREATE NAMESPACE IF NOT EXISTS n', 'decisions'],
      ['CREATE LIGHTNING DATABASE d; DROP TABLE t', 'decisions'], ['SELECT a FROM d.t LIMIT 1', 'usl-resume'], ['CREATE NAMESPACE IF NOT EXISTS n', 'nobody'], ['CREATE NAMESPACE IF NOT EXISTS n', undefined]];
    for (const [sql, caller] of bad) await assert.rejects(client.runLegacyMutationSql(sql, 1, { caller } as any), /LEGACY_MUTATION_NOT_ALLOWED/, `${caller}: ${sql}`);
    assert.equal(sent.length, 0, 'nothing reached the transport');
    await client.runLegacyMutationSql('CREATE NAMESPACE IF NOT EXISTS lightning.metastore.n', 1, { caller: 'usl-complete' });
    await client.runLegacyMutationSql('COMPILE USL m NAMESPACE n DDL\nCREATE TABLE t (\n  a varchar(1)\n);\nCREATE TABLE u (\n  b varchar(1)\n);', 1, { caller: 'usl-complete' });
    await client.runLegacyMutationSql('LOAD USL m NAMESPACE n', 1, { caller: 'usl-resume' });
    assert.equal(sent.length, 3);
    const lines = fs.readFileSync(traceFile, 'utf8').slice(before).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'zetaris-legacy-mutation-sql');
    assert.equal(lines.length, 3); assert.equal(lines[0].sql, 'CREATE NAMESPACE IF NOT EXISTS lightning.metastore.n'); assert.equal(lines[0].caller, 'usl-complete'); assert.match(lines[0].sqlSha256, /^[a-f0-9]{64}$/);
    assert.ok(!fs.readFileSync(path.join(ROOT, 'src/usl/demo.ts'), 'utf8').includes('z.runSql(sql,limit)'), 'demo.ts has no fallback to runSql for mutations');
  } finally { globalThis.fetch = prior; }
});

test('RC-2b: register may send CREATE SCHEMASTORE CONTAINER/VIEW and CACHE TABLE as single closed statements, and nothing else', () => {
  const ok = ['CREATE SCHEMASTORE CONTAINER pokeapi', 'CREATE SCHEMASTORE VIEW v WITH CONTAINER c AS\nSELECT a, b FROM s.t', 'CACHE TABLE NOAA_GHCN_S3.noaa_va_airport', 'CREATE LIGHTNING DATABASE d DESCRIBE BY "x"'];
  for (const sql of ok) assert.doesNotThrow(() => assertLegacyMutationSql(sql, 'register'), sql);
  const bad = ['CREATE SCHEMASTORE CONTAINER c; DROP TABLE t', 'CACHE TABLE a.b; CACHE TABLE c.d', 'CREATE SCHEMASTORE VIEW v WITH CONTAINER c AS DELETE FROM t', 'CREATE SCHEMASTORE VIEW v WITH CONTAINER c AS SELECT 1; DROP TABLE t',
    'CREATE SCHEMASTORE VIEW v WITH CONTAINER c AS SELECT 1 -- x', 'CACHE TABLE a.b /* c */', 'CREATE SCHEMASTORE CONTAINER c AS SELECT 1'];
  for (const sql of bad) assert.throws(() => assertLegacyMutationSql(sql, 'register'), /LEGACY_MUTATION_NOT_ALLOWED/, sql);
  for (const caller of ['decisions', 'usl-complete', 'usl-index', 'usl-resume', 'usl-demo', 'register-madi'])
    for (const sql of ok.slice(0, 3)) assert.throws(() => assertLegacyMutationSql(sql, caller), /LEGACY_MUTATION_NOT_ALLOWED/, `${caller}: ${sql}`);
});

test('RC-2b: every statement of the local getting-started catalog that registrationDecision accepts passes the register allowlist', async () => {
  const { splitCatalogSql, registrationDecision } = await import('../src/register.ts');
  const dir = path.join(ROOT, '../getting-started');
  if (!fs.existsSync(dir)) return;
  const files: string[] = [], walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(f); } else if (f.endsWith('.sql')) files.push(f); } };
  walk(dir);
  let accepted = 0; const failed: string[] = [];
  for (const file of files) for (const sql of splitCatalogSql(fs.readFileSync(file, 'utf8'))) {
    if (registrationDecision(sql)) continue;
    accepted++; try { assertLegacyMutationSql(sql, 'register'); } catch { failed.push(`${path.basename(file)}: ${sql.slice(0, 80)}`); }
  }
  assert.deepEqual(failed, []); assert.ok(accepted > 0);
});

test('RC-2a: the whole completeUsl plan is checked before the first statement; U1 (needs UPDATE USL) is refused with nothing sent', async t => {
  const { assertCompleteUslPlanAllowed, completeUslStatements, completeUsl } = await import('../src/usl/complete.ts');
  const fixture = readJson<any>('output_examples/sample-fixture/U1.json'), plan = buildCompleteUsl('U1', fixture.relations);
  const statements = completeUslStatements('U1', plan);
  assert.ok(statements.some(item => /^UPDATE USL /.test(item.sql)) && /^CREATE NAMESPACE/.test(statements[0].sql));
  assert.throws(() => assertCompleteUslPlanAllowed('U1', plan), (error: any) => error.code === 'USL_PLAN_REQUIRES_AUTHORIZED_PATH' && /UPDATE USL u1_usl/.test(String(error.detail ?? error.message)));
  const u2 = { ...plan, id: 'U2' };
  assert.doesNotThrow(() => assertCompleteUslPlanAllowed('U2', u2 as any));
  const tampered = { ...u2, plans: u2.plans.map((table: any, index: number) => index === 0 ? { ...table, activation: table.activation + '; DROP TABLE x' } : table) };
  assert.throws(() => assertCompleteUslPlanAllowed('U2', tampered as any), (error: any) => error.code === 'USL_PLAN_REQUIRES_AUTHORIZED_PATH' && /ACTIVATE USL TABLE/.test(String(error.detail ?? error.message)));
  // completeUsl itself with a simulated transport: zero sends and the same error.
  if (fs.existsSync(path.join(ROOT, '.concordia/03b-U1-continuation.json'))) return t.skip('03b continuation lock present: completeUsl refuses earlier');
  const relationsPath = path.join(ROOT, 'out/U1/relaciones.json'), previous = fs.existsSync(relationsPath) ? fs.readFileSync(relationsPath) : null;
  fs.mkdirSync(path.dirname(relationsPath), { recursive: true }); fs.writeFileSync(relationsPath, JSON.stringify({ relations: fixture.relations }));
  const prior = globalThis.fetch, saved = { u: process.env.ZETARIS_REST_URL, k: process.env.ZETARIS_API_KEY, o: process.env.ZETARIS_ORG_ID }, sent: string[] = [];
  process.env.ZETARIS_REST_URL = 'http://localhost'; process.env.ZETARIS_API_KEY = 'synthetic'; process.env.ZETARIS_ORG_ID = '1';
  globalThis.fetch = (async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body).sql); return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
  try {
    await assert.rejects(completeUsl('U1'), (error: any) => error.code === 'USL_PLAN_REQUIRES_AUTHORIZED_PATH');
    assert.equal(sent.length, 0, 'no CREATE/LOAD/COMPILE reached the transport');
  } finally {
    globalThis.fetch = prior;
    for (const [key, value] of [['ZETARIS_REST_URL', saved.u], ['ZETARIS_API_KEY', saved.k], ['ZETARIS_ORG_ID', saved.o]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (previous !== null) fs.writeFileSync(relationsPath, previous); else fs.rmSync(relationsPath, { force: true });
  }
});

test('L3-1: only the exact bounded aggregate (COUNT, COUNT DISTINCT, SUM CASE over a LIMITed subquery, concordia_* aliases) passes the runSql gate', () => {
  const profile = (key: string, inner: string, tail = 'concordia_bounded') => `SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ${key}) AS concordia_distinct, SUM(CASE WHEN ${key} IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM (${inner}) ${tail}`;
  for (const sql of [profile('ss_item_sk', 'SELECT `ss_item_sk` FROM TPCDS_DB.store_sales LIMIT 20'), profile('k', "SELECT k FROM (SELECT CAST(a AS STRING) AS k FROM d.t WHERE b = 'x') concordia_source LIMIT 20")])
    assert.doesNotThrow(() => assertRunSqlAllowed(sql), sql);
  const refused = [
    profile('k', 'SELECT k FROM d.t'), profile('k', 'SELECT k FROM d.t LIMIT 20', 'x'), profile('k', 'SELECT k FROM d.t LIMIT 20) y, (SELECT 1', 'concordia_bounded'),
    profile('k', 'SELECT k FROM d.t ORDER BY k LIMIT 20'), profile('k', 'SELECT k FROM d.t JOIN e LIMIT 20'), profile('k', 'SELECT COUNT(*) FROM d.t GROUP BY k LIMIT 20'), profile('k', 'SELECT k FROM d.t UNION SELECT k FROM e LIMIT 20'),
    profile('k', 'DELETE FROM d.t LIMIT 20'), profile('k', 'SELECT k FROM d.t LIMIT 20 -- x'), profile('k', 'SELECT k FROM d.t /* c */ LIMIT 20'), profile('k', 'SELECT k FROM d.t LIMIT 20') + '; DROP TABLE t',
    profile('k', 'SELECT k FROM d.t LIMIT 20').replace('SUM(CASE WHEN k IS', 'SUM(CASE WHEN other IS'), profile('k', 'SELECT k FROM d.t LIMIT 20').replace('concordia_rows', 'rows_total'),
    'SELECT COUNT(*) FROM d.t LIMIT 1', 'SELECT COUNT(*) AS concordia_rows FROM (SELECT k FROM d.t LIMIT 20) concordia_bounded',    'SELECT a FROM d.t ORDER BY a LIMIT 1', 'SELECT a FROM d.t JOIN e LIMIT 1', profile('k', 'SELECT k FROM d.t LIMIT 20') + ' UNION SELECT 1'];
  for (const sql of refused) assert.throws(() => assertRunSqlAllowed(sql), /FORBIDDEN_SQL|READ_PATH_MUTATION_FORBIDDEN/, sql);
});

test('L3-1: every exploration action of every universe config compiles to SQL that the real runSql gate accepts (0 rejections)', async () => {
  const { compileReadSql } = await import('../src/agent/exploration.ts');
  const dir = path.join(ROOT, 'universes');
  let compiled = 0; const rejected: string[] = [], kinds = new Set<string>();
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    let cfg: any; try { cfg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    const catalog = cfg?.explorationCatalog; if (!catalog?.actions) continue;
    for (const action of catalog.actions) {
      const spec = cfg.tables?.[action.table]; if (!spec) continue;
      const described = new Set<string>([...(spec.columns ?? []).map((c: any) => c.name), ...(catalog.safeOptionalColumns?.[action.table] ?? []), action.filterColumn]);
      const values = action.observation ? ['1', '2'] : [];
      try { const { sql } = compileReadSql(action, cfg, catalog, described, values, 20); compiled++; kinds.add(action.kind); assertRunSqlAllowed(sql); }
      catch (error: any) { rejected.push(`${file}:${action.id}:${error?.code ?? error?.message}`); }
    }
  }
  assert.deepEqual(rejected, []); assert.ok(compiled > 0 && kinds.has('BOUNDED_PROFILE') && kinds.has('KEYED_READ'), `compiled ${compiled}`);
});

test('L3-1b: only the exact keyed aggregate (AGGREGATE_COUNT) passes; other GROUP BY, COUNT, wide lists and tampered keys stay vetoed', () => {
  const agg = (key: string, from: string, list = "'1', '2'", group = key, limit = '20') => `SELECT ${key}, COUNT(*) AS concordia_count FROM ${from} WHERE ${key.replaceAll('`', '')} IN (${list}) GROUP BY ${group} LIMIT ${limit}`;
  const ok = [agg('k', 'D.t'), agg('`k`', 'D.t'), agg('k', '((SELECT CAST(a AS STRING) AS k FROM d.x) concordia_source) concordia_source'), agg('k', 'D.t', "'a.b-c_9'")];
  for (const sql of ok) assert.doesNotThrow(() => assertRunSqlAllowed(sql), sql);
  const wide = Array.from({ length: 51 }, (_, i) => `'${i}'`).join(', ');
  const refused = [agg('k', 'D.t', "'1'", 'k, j'), agg('k', 'D.t', "'1'", 'j'), agg('k', 'D.t').replace(' LIMIT 20', ''), agg('k', 'D.t', wide), agg('k', 'D.t', "'a b'"), agg('k', 'D.t', "'it''s'"), agg('k', 'D.t', '1, 2'),
    agg('k', 'D.t').replace('IN (', 'IN (SELECT k FROM e UNION '), agg('k', 'D.t').replace('WHERE k', 'WHERE j'), agg('k', 'D.t').replace('concordia_count', 'n'), agg('k', 'D.t') + '; DROP TABLE t', agg('k', 'D.t') + ' -- x',
    agg('k', 'D.t JOIN e'), agg('k', 'D.t', "'1'", 'k ORDER BY k'), agg('k', '(SELECT k FROM e JOIN f) concordia_source'), agg('k', '(SELECT k FROM e GROUP BY k) concordia_source'), agg('k', '(SELECT COUNT(*) FROM e) concordia_source'),
    agg('k', '(SELECT k FROM e LIMIT 1) y'), agg('k', 'D.t').replace('SELECT k,', 'SELECT k, j,'), 'SELECT k, COUNT(*) AS concordia_count FROM D.t GROUP BY k LIMIT 5', 'SELECT k, COUNT(*) FROM D.t GROUP BY k'];
  for (const sql of refused) assert.throws(() => assertRunSqlAllowed(sql), /FORBIDDEN_SQL|READ_PATH_MUTATION_FORBIDDEN/, sql);
});

test('L3-1b: a synthetic catalog with AGGREGATE_COUNT and COMPARE_KEYS (plain and baseSql tables) compiles to SQL the real gate accepts', async () => {
  const { compileReadSql } = await import('../src/agent/exploration.ts');
  const cfg: any = { tables: { t: { db: 'D', physicalTable: 't', columns: [{ name: 'k' }, { name: 'v' }] }, b: { db: 'D', physicalTable: 'b', baseSql: 'SELECT CAST(a AS STRING) AS k FROM d.x', columns: [{ name: 'k' }] } } };
  const catalog: any = { observations: {}, actions: [] };
  let accepted = 0;
  for (const table of ['t', 'b']) for (const kind of ['AGGREGATE_COUNT', 'COMPARE_KEYS', 'KEYED_READ', 'BOUNDED_PROFILE']) {
    const action: any = { id: `${kind}_${table}`, kind, table, filterColumn: 'k', ...(kind === 'BOUNDED_PROFILE' ? {} : { observation: 'o' }) };
    const { sql } = compileReadSql(action, cfg, catalog, new Set(['k', 'v']), kind === 'BOUNDED_PROFILE' ? [] : ['1', '2'], 20);
    assert.doesNotThrow(() => assertRunSqlAllowed(sql), `${kind}/${table}: ${sql}`); accepted++;
  }
  assert.equal(accepted, 8);
});

test('N67: SELECT ... INTO OUTFILE/DUMPFILE is refused by the read path', () => {
  for (const sql of ["SELECT a FROM d.t INTO OUTFILE '/tmp/x'", 'SELECT a FROM d.t INTO DUMPFILE "/tmp/x"', 'select a from d.t into  outfile x', 'WITH a AS (SELECT 1) SELECT * FROM a INTO OUTFILE x', 'SELECT a INTO OUTFILE x FROM d.t'])
    assert.throws(() => assertReadPathSql(sql), /READ_PATH_MUTATION_FORBIDDEN/, sql);
  assert.doesNotThrow(() => assertReadPathSql("SELECT 'INTO OUTFILE' AS s FROM d.t"));
});

test('HR-3: the legacy COMPILE payload is linted (shape, ASCII, no comments or verbs) and capped; the real USL plans pass', () => {
  const head = 'COMPILE USL m DEPLOY NAMESPACE lightning.metastore.n DDL\n', table = (name: string, columns = 1) => `CREATE TABLE ${name} (\n${Array.from({ length: columns }, (_, i) => `  c${i} varchar(512)`).join(',\n')}\n);`;
  const ok = [head + table('a'), head + table('a', 3) + '\n' + table('b'), head + 'CREATE TABLE z (\n  id varchar(16) NOT NULL PRIMARY KEY,\n  p varchar(128) FOREIGN KEY REFERENCES a(c0)\n);\n'];
  for (const sql of ok) assert.doesNotThrow(() => assertLegacyMutationSql(sql, 'usl-complete'), sql);
  const bad = [head + 'DROP TABLE a;', head + table('a') + '\nDROP TABLE a;', head + table('a').replace('varchar(512)', "varchar(512) COMMENT 'x'"), head + table('a') + ' -- x', head + table('a') + ' /* x */', head + table('a') + '\nCREATE TABLE b AS SELECT 1;',
    head + 'CREATE TABLE a (\n  c0 varchar(512),\n);', head + 'CREATE TABLE a (\n  c0 int\n);', head + table('a').replace('c0', 'c0; DROP'), head + table('a') + '\u00e9', head + table('a').replace('\n);', '\r\n);'),
    head + table('a', 201), head + Array.from({ length: 31 }, (_, i) => table('t' + i)).join('\n'), head + table('a', 10) + '\n' + 'x'.repeat(20_000), head + 'ALTER TABLE a ADD COLUMN c varchar(1);', head + '', head + 'INSERT INTO a VALUES (1);'];
  for (const sql of bad) assert.throws(() => assertLegacyMutationSql(sql, 'usl-complete'), /LEGACY_MUTATION_NOT_ALLOWED/, JSON.stringify(sql.slice(0, 120)));
  const fixture = readJson<any>('output_examples/sample-fixture/U1.json'), plan = buildCompleteUsl('U1', fixture.relations);
  assert.doesNotThrow(() => assertLegacyMutationSql(`COMPILE USL ${plan.model} NAMESPACE ${plan.namespace} DDL\n${plan.ddl}`, 'usl-complete'));
  assert.doesNotThrow(() => assertLegacyMutationSql(`COMPILE USL ${plan.model} DEPLOY NAMESPACE ${plan.namespace} DDL\n${plan.ddl}`, 'usl-demo'));
});

test('N71: REST TABLE HEADER, BODY, OPTIONS and endpoint query strings are redacted in the traces; the sent SQL and its sha256 stay exact', async () => {
  const sql = 'CREATE LIGHTNING REST TABLE t FROM S REQUEST(\n  endpoint "https://x.test/v1/a?api_key=SECRET1&b=2",\n  method "get"\n) HEADER (\n  user-agent "App me@x.org",\n  authorization "Bearer SECRET2"\n) BODY (\n  token "SECRET3"\n) OPTIONS (pw \'SECRET4\')';
  const redacted = redactSqlForTrace(sql);
  for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'me@x.org']) assert.ok(!redacted.includes(secret), secret);
  assert.match(redacted, /^CREATE LIGHTNING REST TABLE t FROM S REQUEST\(/); assert.match(redacted, /endpoint "https:\/\/x\.test\/v1\/a\?\[REDACTED\]"/); assert.match(redacted, /HEADER \(\[REDACTED\]\) BODY \(\[REDACTED\]\) OPTIONS \(\[REDACTED\]\)$/);
  assert.equal(redactSqlForTrace('SELECT a FROM d.t LIMIT 1'), 'SELECT a FROM d.t LIMIT 1');
  const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' }), prior = globalThis.fetch, sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body).sql); return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
  const traceFile = path.join(ROOT, 'evidence/trace.jsonl'), before = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').length : 0;
  try {
    await client.runLegacyMutationSql(sql, 1, { caller: 'decisions' });
    assert.equal(sent[0], sql, 'the backend still receives the exact statement');
    const traced = fs.readFileSync(traceFile, 'utf8').slice(before);
    for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'me@x.org']) assert.ok(!traced.includes(secret), `trace leaks ${secret}`);
    const legacy = traced.trim().split('\n').map(line => JSON.parse(line)).find(event => event.kind === 'zetaris-legacy-mutation-sql');
    assert.equal(legacy.run, SYNTHETIC_RUN, 'synthetic events are labelled');
    assert.equal(legacy.sqlSha256, createHash('sha256').update(sql, 'utf8').digest('hex'));
  } finally { globalThis.fetch = prior; }
});

test('HR-2: an UNQUOTED column named like a mutation verb is rejected on purpose (known false positive, fail-closed); quoted identifiers pass', () => {
  for (const sql of ['SELECT update FROM d.t', 'SELECT a, delete FROM d.t', 'SELECT a FROM d.t WHERE insert = 1', 'SELECT merge FROM d.t', 'SELECT create FROM d.t'])
    assert.throws(() => assertReadPathSql(sql), /READ_PATH_MUTATION_FORBIDDEN/, sql);
  for (const sql of ['SELECT `update` FROM d.t', 'SELECT "delete" FROM d.t', 'SELECT `insert`, a FROM d.t WHERE `merge` = 1', 'SELECT updated_at, deleted, created FROM d.t'])
    assert.doesNotThrow(() => assertReadPathSql(sql), sql);
});

test('N61: p4-live-freshness sends its two CREATE statements through the explicit legacy method (closed form, own caller), never runSql', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/p4-live-freshness.ts'), 'utf8');
  assert.equal((script.match(/runLegacyMutationSql\(`CREATE LIGHTNING/g) ?? []).length, 2); assert.ok(!/runSql\(`CREATE/.test(script));
  for (const sql of ['CREATE LIGHTNING DATABASE MADI08_P4_FRESHNESS DESCRIBE BY "Isolated Concordia P4 freshness contract fixture"', 'CREATE LIGHTNING FILESTORE TABLE source FROM MADI08_P4_FRESHNESS FORMAT CSV OPTIONS (PATH "/home/zetaris/customer-data/shared/concordia-p4-freshness-v1/source.csv", header "true", inferSchema "false")'])
    assert.doesNotThrow(() => assertLegacyMutationSql(sql, 'p4-live-freshness'), sql);
  assert.throws(() => assertLegacyMutationSql('COMPILE USL m DEPLOY NAMESPACE n DDL\nCREATE TABLE t (\n  a varchar(1)\n);', 'p4-live-freshness'), /LEGACY_MUTATION_NOT_ALLOWED/);
});

test('R9-G: the full-evidence forms F1, F2, F3a, F3b and F4 of the contract pass the runSql gate; every variant stays FORBIDDEN_SQL', async () => {
  const sub = (cols: string, table: string) => `(SELECT ${cols} FROM ${table}) concordia_source`;
  const f1 = (k: string, src: string) => `SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ${k}) AS concordia_distinct, SUM(CASE WHEN ${k} IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM ${src}`;
  const f2 = (k: string, src: string, n = '20') => `SELECT ${k}, COUNT(*) AS concordia_count FROM ${src} GROUP BY ${k} HAVING COUNT(*) > 1 LIMIT ${n}`;
  const anti = (a: string, from: string, b: string, to: string) => `(SELECT DISTINCT ${a} AS k FROM ${from} WHERE ${a} IS NOT NULL) concordia_s LEFT JOIN (SELECT DISTINCT ${b} AS k FROM ${to}) concordia_t ON concordia_s.k = concordia_t.k WHERE concordia_t.k IS NULL`;
  const f3a = (a: string, from: string, b: string, to: string, n = '20') => `SELECT concordia_s.k FROM ${anti(a, from, b, to)} LIMIT ${n}`;
  const f3b = (a: string, from: string, b: string, to: string) => `SELECT COUNT(*) AS concordia_missing FROM ${anti(a, from, b, to)}`;
  const f4 = (k: string, src: string, n = '20') => `SELECT DISTINCT ${k} FROM ${src} WHERE ${k} IS NOT NULL LIMIT ${n}`;
  const store = sub('s_store_sk, s_store_id, s_store_name, s_closed_date_sk', 'TPCDS_DB.store');
  const positives = [f1('s_store_sk', store), f1('`s_store_sk`', 'TPCDS_DB.store'), f2('cp_catalog_page_sk', 'TPCDS_DB.catalog_page'), f2('k', store, '50'), f2('`k`', 'D.t', '1'),
    f3a('ss_store_sk', 'TPCDS_DB.store_sales', 's_store_sk', 'TPCDS_DB.store'), f3a('a', sub('a, b', 'D.s'), 'b', store, '50'), f3b('ss_store_sk', 'TPCDS_DB.store_sales', 's_store_sk', 'TPCDS_DB.store'),
    f3b('`a`', sub('a', 'D.s'), '`b`', 'D.t'), f4('k', 'D.t'), f4('k', store, '999')];
  for (const sql of positives) assert.doesNotThrow(() => assertRunSqlAllowed(sql), sql);
  assert.doesNotThrow(() => assertReadPathSql(f4('k', 'D.t')), 'F4 was already accepted by the read path: no change needed');
  const negatives = [
    f1('s_store_sk', 'D.t') + ' LIMIT 5', f1('a', 'D.t').replace('concordia_rows', 'rows'), f1('a', 'D.t').replace('IS NULL THEN 1', 'IS NULL THEN 2'), f1('a', 'D.t').replace('SUM(CASE WHEN a', 'SUM(CASE WHEN b'), f1('a', 'D.t') + ' GROUP BY a', f1('a', 'D.t') + ' ORDER BY a',
    f1('a', sub('a', 'D.t JOIN D.u')), f1('a', sub('a', 'D.t UNION SELECT 1')), f1('a', sub('COUNT(*)', 'D.t')), f1('a', '(SELECT a FROM D.t) other'), f1('a', 'D.t; DROP TABLE x'), f1('a', 'D.t') + ' -- c', f1('a', 'D.t t'),
    f2('k', 'D.t').replace(/ LIMIT 20$/, ''), f2('k', 'D.t', '51'), f2('k', 'D.t', '0'), f2('k', 'D.t').replace('> 1', '> 2'), f2('k', 'D.t').replace('GROUP BY k', 'GROUP BY j'), f2('k', 'D.t').replace('concordia_count', 'n'), f2('k', 'D.t') + ' ORDER BY k', f2('k', 'D.t').replace('HAVING COUNT(*) > 1', 'HAVING COUNT(*) > 1 AND k > 0'),
    f3a('a', 'D.s', 'b', 'D.t').replace(/ LIMIT 20$/, ''), f3a('a', 'D.s', 'b', 'D.t', '51'), f3a('a', 'D.s', 'b', 'D.t').replace('LEFT JOIN', 'INNER JOIN'), f3a('a', 'D.s', 'b', 'D.t').replace('LEFT JOIN', 'RIGHT JOIN'), f3a('a', 'D.s', 'b', 'D.t').replace('concordia_t.k IS NULL', 'concordia_t.k IS NOT NULL'),
    f3a('a', 'D.s', 'b', 'D.t').replace('WHERE a IS NOT NULL', 'WHERE c IS NOT NULL'), f3a('a', 'D.s', 'b', 'D.t').replace('ON concordia_s.k = concordia_t.k', 'ON concordia_s.k <> concordia_t.k'), f3a('a', 'D.s', 'b', 'D.t').replace('SELECT concordia_s.k', 'SELECT concordia_s.k, concordia_t.k'),
    f3a('a', 'D.s', 'b', 'D.t').replace('SELECT DISTINCT a', 'SELECT a'), f3a('a', 'D.s', 'b', 'D.t') + ' ORDER BY 1', f3a('a', sub('a', 'D.s JOIN D.u'), 'b', 'D.t'), f3a('a', 'D.s', 'b', 'D.t').replace('concordia_t ON', 'other ON'),
    f3b('a', 'D.s', 'b', 'D.t') + ' LIMIT 5', f3b('a', 'D.s', 'b', 'D.t').replace('concordia_missing', 'missing'), f3b('a', 'D.s', 'b', 'D.t').replace('COUNT(*)', 'COUNT(DISTINCT a)'), f3b('a', 'D.s', 'b', 'D.t').replace('WHERE a IS NOT NULL', 'WHERE c IS NOT NULL'),
    f3b('a', 'D.s', 'b', 'D.t') + '; SELECT 1', f3b('a', 'D.s', 'b', 'D.t').replace('LEFT JOIN', 'LEFT OUTER JOIN'), 'SELECT a FROM D.s JOIN D.t ON D.s.a = D.t.b', 'SELECT COUNT(*) FROM D.s LEFT JOIN D.t ON D.s.a = D.t.b WHERE D.t.b IS NULL',
    f4('k', 'D.t').replace('IS NOT NULL', 'IS NULL') + ' JOIN D.u'];
  for (const sql of negatives) assert.throws(() => assertRunSqlAllowed(sql), /FORBIDDEN_SQL|READ_PATH_MUTATION_FORBIDDEN/, sql);
  const client = new Zetaris({ base: 'http://localhost', key: 'synthetic', org: '1' }), prior = globalThis.fetch, sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body).sql); return new Response(JSON.stringify({ data: [[1]] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
  try { await client.runSql(f3b('a', 'D.s', 'b', 'D.t'), 1); await assert.rejects(client.runSql(f3b('a', 'D.s', 'b', 'D.t') + ' LIMIT 5', 1), /FORBIDDEN_SQL/); assert.equal(sent.length, 1); } finally { globalThis.fetch = prior; }
});

test('R10-AB: F1x (extended profile) and F3c (orphans by rows) are exact closed forms; E1-07 NOT IN is rejected in every evidence form', () => {
  const f1x = (k: string, src: string, tail = '') => `SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT ${k}) AS concordia_distinct, SUM(CASE WHEN ${k} IS NULL THEN 1 ELSE 0 END) AS concordia_nulls, MIN(${k}) AS concordia_min, MAX(${k}) AS concordia_max, AVG(LENGTH(CAST(${k} AS STRING))) AS concordia_avg_len FROM ${src}${tail}`;
  const f3c = (a: string, from: string, b: string, to: string) => `SELECT COUNT(*) AS concordia_missing_rows FROM ${from.replace(/ concordia_source$/, '')} concordia_s LEFT JOIN (SELECT DISTINCT ${b} AS k FROM ${to}) concordia_t ON concordia_s.${a} = concordia_t.k WHERE concordia_s.${a} IS NOT NULL AND concordia_t.k IS NULL`;
  const sub = '(SELECT s_store_sk, s_store_name FROM TPCDS_DB.store) concordia_source';
  for (const sql of [f1x('s_store_sk', 'TPCDS_DB.store'), f1x('`k`', sub), f3c('ss_store_sk', 'TPCDS_DB.store_sales', 's_store_sk', 'TPCDS_DB.store'), f3c('`a`', sub, '`b`', 'D.t'), f3c('a', sub, 'b', sub)]) assert.doesNotThrow(() => assertRunSqlAllowed(sql), sql);
  const negatives = [
    f1x('a', 'D.t', ' LIMIT 5'), f1x('a', 'D.t', ' GROUP BY a'), f1x('a', 'D.t').replace('concordia_min', 'min_v'), f1x('a', 'D.t').replace('MAX(a)', 'MAX(b)'), f1x('a', 'D.t').replace('MIN(a)', 'SUM(a)'),
    f1x('a', 'D.t').replace('AVG(LENGTH(CAST(a AS STRING)))', 'AVG(LENGTH(a))'), f1x('a', 'D.t').replace('AS concordia_avg_len', 'AS concordia_avg_len, STDDEV(a) AS concordia_sd'), f1x('a', 'D.t').replace('AS STRING', 'AS INT'),
    f1x('a', '(SELECT a FROM D.t) other'), f1x('a', sub.replace('FROM TPCDS_DB.store', 'FROM TPCDS_DB.store JOIN D.u')), f1x('a', 'D.t; DROP TABLE x'), f1x('a', 'D.t') + ' -- c',
    f3c('a', 'D.s', 'b', 'D.t').replace('concordia_missing_rows', 'missing'), f3c('a', 'D.s', 'b', 'D.t').replace('COUNT(*)', 'COUNT(DISTINCT concordia_s.a)'), f3c('a', 'D.s', 'b', 'D.t').replace('WHERE concordia_s.a IS NOT NULL AND', 'WHERE'),
    f3c('a', 'D.s', 'b', 'D.t').replace('IS NOT NULL AND', 'IS NOT NULL OR'), f3c('a', 'D.s', 'b', 'D.t').replace('LEFT JOIN', 'INNER JOIN'), f3c('a', 'D.s', 'b', 'D.t').replace('IS NULL', 'IS NOT NULL'),
    f3c('a', 'D.s', 'b', 'D.t').replace('WHERE concordia_s.a IS', 'WHERE concordia_s.c IS'), f3c('a', 'D.s', 'b', 'D.t').replace('SELECT COUNT(*)', 'SELECT COUNT(*), MAX(concordia_s.a)'), f3c('a', 'D.s', 'b', 'D.t') + ' LIMIT 5',
    f3c('a', 'D.s', 'b', 'D.t').replace('(SELECT DISTINCT b AS k FROM D.t)', '(SELECT b AS k FROM D.t)'), f3c('a', 'D.s JOIN D.u', 'b', 'D.t'), f3c('a', sub + ' concordia_s', 'b', 'D.t').replace('concordia_source concordia_s', 'concordia_source concordia_s'),
    f3c('a', 'D.s', 'b', 'D.t').replace('D.s concordia_s', 'D.s concordia_source concordia_s'), f3c('a', 'D.s', 'b', 'D.t').replace('D.s concordia_s', 'D.s concordia_sx'),
    // E1-07: the NOT IN anti-join (NULL in the target makes it return no rows) is not any evidence form, nor a source of one.
    'SELECT COUNT(*) AS concordia_missing FROM (SELECT DISTINCT a AS k FROM D.s WHERE a IS NOT NULL) concordia_s WHERE concordia_s.k NOT IN (SELECT b FROM D.t)',
    'SELECT concordia_s.k FROM (SELECT DISTINCT a AS k FROM D.s WHERE a IS NOT NULL) concordia_s WHERE concordia_s.k NOT IN (SELECT DISTINCT b FROM D.t) LIMIT 20',
    f3c('a', 'D.s', 'b', 'D.t').replace('LEFT JOIN (SELECT DISTINCT b AS k FROM D.t) concordia_t ON concordia_s.a = concordia_t.k WHERE concordia_s.a IS NOT NULL AND concordia_t.k IS NULL', 'WHERE concordia_s.a NOT IN (SELECT b FROM D.t)'),
    'SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT a) AS concordia_distinct, SUM(CASE WHEN a IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM (SELECT a FROM D.t WHERE a NOT IN (SELECT b FROM D.u)) concordia_source'];
  for (const sql of negatives) assert.throws(() => assertRunSqlAllowed(sql), /FORBIDDEN_SQL|READ_PATH_MUTATION_FORBIDDEN/, sql);
});
