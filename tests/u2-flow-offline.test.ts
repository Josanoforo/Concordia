import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ROOT } from '../src/runtime.ts';
import { Zetaris } from '../src/clients/zetaris.ts';
import { Nightshift } from '../src/clients/nightshift.ts';
import { runU2Agent } from '../src/agent/u2.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/**
 * R-05: full offline flow of runU2Agent. Only the three external boundaries are replaced: the Zetaris client (declarative U2 fixture),
 * the Nightshift model (scripted JSON choices) and the COMA subprocess (schema-only bridge answer). Everything else is the real product code.
 */
const receipt = { receiptId: 'u2-flow-receipt', provider: 'anthropic', model: 'fixture', inputTokens: 100, outputTokens: 20, totalTokens: 120, latencyMs: 1, fromCache: false, requestedMode: 'cheap', routedMode: 'cheap' };

test('runU2Agent completes the whole flow offline: discovery, COMA, adaptive reads, joins, probes, critic, report, integrity and run-local memory', async t => {
  const runId = 'agent-u2-offline-flow-01', runDirectory = path.join(ROOT, '.concordia', 'agent-runs', runId);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'u2-flow-'));
  const envFile = path.join(temp, 'test.env'), budgetFile = path.join(temp, 'budget.json');
  fs.writeFileSync(envFile, ['ZETARIS_REST_URL=http://127.0.0.1:1', 'ZETARIS_API_KEY=test-key', 'ZETARIS_ORG_ID=1', 'METERLESS_BASE_URL=http://127.0.0.1:1', 'METERLESS_RUNTIME_TOKEN=test-token', 'METERLESS_MODEL=meterless/test'].join('\n'));
  fs.writeFileSync(budgetFile, JSON.stringify({ limit: null, consumed: 0, attempts: [] }));
  const budgetBefore = fs.readFileSync(budgetFile, 'utf8');
  const saved = { env: { ...process.env }, spawnSync: childProcess.spawnSync, fetch: globalThis.fetch, lstatSync: fs.lstatSync, loadEnvFile: process.loadEnvFile };
  process.env.CONCORDIA_LOCAL_ENV_FILE = envFile; process.env.CONCORDIA_BUDGET_FILE = budgetFile;
  // CI preloads a guard that makes process.loadEnvFile throw; only this test's own temporary env file is loaded, by assigning its test values.
  process.loadEnvFile = ((file?: string | URL) => {
    if (path.resolve(String(file)) !== path.resolve(envFile)) return saved.loadEnvFile.call(process, file as any);
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const at = line.indexOf('='); if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1); }
  }) as typeof process.loadEnvFile;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
    process.loadEnvFile = saved.loadEnvFile; childProcess.spawnSync = saved.spawnSync; (fs as any).lstatSync = saved.lstatSync; syncBuiltinESMExports(); globalThis.fetch = saved.fetch;
    fs.rmSync(runDirectory, { recursive: true, force: true }); fs.rmSync(temp, { recursive: true, force: true });
  });
  assert.ok(!fs.existsSync(runDirectory), 'the run directory is new');
  globalThis.fetch = (async () => { throw new Error('network is forbidden in this test'); }) as typeof fetch;

  const fixture = agentFixtures().find(item => item.alias === 'U2')!;
  const sqlLog: string[] = [], source = fixtureClient(universeConfig('U2'), fixture.tables, sqlLog);
  const zetaris = Zetaris.prototype as any, nightshift = Nightshift.prototype as any;
  const originals = { runSql: zetaris.runSql, describe: zetaris.describe, chat: nightshift.chat };
  t.after(() => { Object.assign(zetaris, { runSql: originals.runSql, describe: originals.describe }); nightshift.chat = originals.chat; });
  zetaris.runSql = (sql: string, limit?: number) => source.runSql(sql, limit);
  zetaris.describe = (db: string, table: string) => source.describe(db, table);
  const stages: string[] = [];
  nightshift.chat = async (messages: { content: string }[]) => {
    const asked = JSON.parse(messages[1].content), allowed: string[] = asked.allowedActions;
    stages.push(asked.stage);
    const pick = allowed.find(id => id === 'CIK_NORMALIZED') ?? allowed.find(id => id === 'SIC_CODE') ?? allowed.find(id => !id.startsWith('STOP_') && id !== 'NO_JOIN') ?? allowed[allowed.length - 1];
    return { text: JSON.stringify({ action: pick, reason: 'Scripted offline choice from observed rows.' }), receipt, policyAlerts: [] };
  };
  // COMA subprocess: pretend the installed interpreter exists and answers with a schema-only match for every pair.
  const pythonRoot = path.resolve(ROOT, '.concordia/python/coma-valentine-1.1.0');
  (fs as any).lstatSync = ((target: fs.PathLike, ...rest: any[]) => String(target).startsWith(pythonRoot) && !fs.existsSync(target as string)
    ? ({ isSymbolicLink: () => false } as fs.Stats) : (saved.lstatSync as any)(target, ...rest)) as typeof fs.lstatSync;
  (childProcess as any).spawnSync = (_file: string, _args: string[], options: { input: string }) => {
    const request = JSON.parse(options.input);
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0',
      configuration: { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0.0, instance_weight: 1.0 },
      matches: request.pairs.map((pair: any) => ({ source: pair.source, target: pair.target, matches: [] })) }) };
  };
  syncBuiltinESMExports();

  const log = console.log; console.log = () => {};
  let result: any;
  try { result = await runU2Agent({ runId, task: 'Offline company brief for the configured U2 company.' }); } finally { console.log = log; }

  assert.equal(result.status, 'COMPLETED_WITH_REVIEW_PENDING');
  assert.equal(result.review.status, 'PENDING'); assert.equal(result.review.sourceEvidenceChangedByDecision, false);
  assert.deepEqual([...result.tablesRead].sort(), ['apple_revenue_facts', 'apple_submissions_raw', 'sic_reference']);
  assert.ok(stages.includes('choose_company_identity_join') && stages.includes('choose_company_dns_join'), 'both join decisions were asked of the model');
  assert.ok(sqlLog.length > 0 && sqlLog.every(sql => /\bLIMIT\b/i.test(sql) && !/\b(COUNT|JOIN|ORDER\s+BY|GROUP\s+BY)\b/i.test(sql)), 'every read is bounded and join-free');

  const report = JSON.parse(fs.readFileSync(path.join(ROOT, result.reportPath), 'utf8'));
  assert.equal(report.universeId, 'U2'); assert.equal(report.runId, runId);
  assert.equal(report.adaptiveExploration.plannerStatus, 'MODEL_DECISIONS_RECORDED');
  assert.equal(report.adaptiveExploration.joins.choice.identityJoin.choice, 'CIK_NORMALIZED');
  assert.equal(report.adaptiveExploration.joins.choice.verificationStatus, 'NO VERIFICADO/UNKNOWN');
  assert.ok(report.adaptiveExploration.joins.alternatives.length >= 4, 'every join alternative is compared');
  assert.ok(report.profile.length >= 1 && report.profile[0].legalName, 'the profile is built from the bounded SEC read');
  assert.ok(report.relationEvidence.every((item: any) => item.verdict !== 'SOSTENIDA'), 'one-row synthetic samples never sustain a relation');
  assert.equal(report.critic.status, 'EVALUATED');
  // evidence/trace.jsonl is shared with other test processes, so only the per-universe state files are compared here.
  const protection = (name: string) => JSON.parse(fs.readFileSync(path.join(runDirectory, name), 'utf8')) as { path: string; sha256?: string }[];
  assert.equal(report.integrity.protectedArtifactCount, 10);
  const stateOnly = (items: { path: string; sha256?: string }[]) => items.filter(item => item.path.startsWith('.concordia/U'));
  assert.deepEqual(stateOnly(protection('protection-after.json')), stateOnly(protection('protection-before.json')), 'U1/U2/U3 state is untouched by the run');
  assert.equal(typeof report.integrity.protectedArtifactsUnchanged, 'boolean');
  assert.equal(report.integrity.budgetPrefixPreserved, true);
  assert.equal(fs.readFileSync(budgetFile, 'utf8'), budgetBefore, 'the generation ledger is only read');
  for (const file of ['discovery.json', 'adaptive-exploration.json', 'adaptive-decisions.jsonl', 'protection-before.json', 'protection-after.json', 'report.json']) assert.ok(fs.existsSync(path.join(runDirectory, file)), file);
  assert.ok(fs.existsSync(path.join(runDirectory, 'memory')), 'memory is run-local');
  assert.match(report.memory.scope, /run-local/);
});
