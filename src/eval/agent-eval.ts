import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ActionChooser, type ChoiceCall } from '../agent/chooser.ts';
import { runAgent } from '../agent/engine.ts';
import { resolveUniverseManifest, universeManifests } from '../registry/universes.ts';
import { legacyRelationContract } from '../relations/legacy.ts';
import { readJson, ROOT } from '../runtime.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { universeConfig } from '../universe-pipeline.ts';
import { catalogOf } from '../agent/catalog.ts';
import { fixtureClient, fixtureTablesFromConfig, type AgentFixture } from './fixture-client.ts';
import { offlineAgentDeps } from '../agent/offline-deps.ts';
import { COMA_STANDIN_ID } from './fixture-coma.ts';
import { createEvaluationProtocol, evaluateDevelopment, type EvaluationCase, type MethodRun } from './protocol.ts';

/** Replays a fixed id script, then stops. Offline stand-in for the model; it can only pick permitted ids. */
class ScriptChooser implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION';
    const selected = allowed.includes(next) ? next : undefined;
    return { stage, status: 'PASS', decisionStatus: selected ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'fixture-script', selected, reason: 'fixture script choice', promptHash: 'fixture', utc: '2026-10-24T00:00:00.000Z' };
  }
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FROZEN_AT = '2026-10-24T00:00:00Z';
export const METHODS = [{ methodId: 'agent-loop', explore: true }, { methodId: 'probes-only', explore: false }] as const;

export function agentFixtures(): AgentFixture[] {
  const dir = path.join(ROOT, 'eval', 'agent');
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as AgentFixture);
  // R-03: an AGENT_EXPLORATION universe on the local-files adapter carries its own rows, so it needs no separate fixture file.
  const derived = universeManifests.filter(manifest => manifest.source.adapterId === 'local-files' && manifest.capabilities.includes('AGENT_EXPLORATION')
    && !files.some(fixture => manifest.aliases.includes(fixture.alias))).map(manifest => derivedLocalFixture(manifest.aliases[0]));
  return [...files, ...derived].sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Local universe fixture derived from its config: every catalog action in order, truth UNKNOWN because no adjudication is declared. */
export function derivedLocalFixture(alias: string): AgentFixture {
  const cfg = universeConfig(alias);
  return { alias, basis: 'LOCAL_CONFIG_ROWS: tables are the config fixtureRows; no adjudication is declared', chooserScript: (catalogOf(cfg)?.actions ?? []).map((action: any) => action.id),
    tables: fixtureTablesFromConfig(cfg), adjudications: Object.fromEntries((cfg.relations ?? []).map((relation: any) => [relation.id, 'UNKNOWN' as const])) };
}

type EvalRun = { method: string; alias: string; status: string; queries: number; steps: number; probes: number; actionsPass: number; configuredRelations: number; comaStatus: string; postComaExecuted: number; /** Identity of the offline COMA stand-in when the run used it; null for a real or absent COMA. */ comaProvider?: string | null };
/**
 * Minimum PASS criteria of the agent-loop method per universe (S5). An agent-loop that takes no step, performs no exploration action or probes nothing is not a pass:
 * - the run is COMPLETED (a DEGRADED_NO_MODEL or any other status fails it offline);
 * - steps > 0 and at least one exploration action executed;
 * - with configured relations, probes > 0; a blind universe (no relations) instead needs an executed post-COMA probe, or COMA explicitly recorded as NOT_CONFIGURED;
 * - every agent-capable universe has a fixture and an agent-loop run (a skipped or missing fixture is a failure).
 * Pure over the run rows, so it can be tested without running the loop.
 */
export function agentLoopCriteria(input: { runs: readonly EvalRun[]; skipped: readonly { alias: string; reason: string }[]; agentCapable: readonly string[]; fixtures: readonly string[] }) {
  const failures: { alias: string; criterion: string; detail: string }[] = [], byUniverse: Record<string, { passed: boolean; reason: string; failures: string[] }> = {};
  for (const item of input.skipped) failures.push({ alias: item.alias, criterion: 'FIXTURE_REQUIRED', detail: item.reason });
  for (const alias of input.agentCapable) if (!input.fixtures.includes(alias) && !failures.some(item => item.alias === alias)) failures.push({ alias, criterion: 'FIXTURE_REQUIRED', detail: 'NO_OFFLINE_FIXTURE' });
  for (const alias of input.agentCapable) {
    const run = input.runs.find(item => item.alias === alias && item.method === 'agent-loop'), own: string[] = [];
    if (!run) { if (!failures.some(item => item.alias === alias)) failures.push({ alias, criterion: 'AGENT_LOOP_RUN_REQUIRED', detail: 'no agent-loop run' }); byUniverse[alias] = { passed: false, reason: 'NO_RUN', failures: ['AGENT_LOOP_RUN_REQUIRED'] }; continue; }
    if (run.status !== 'COMPLETED') own.push(`STATUS_NOT_COMPLETED:${run.status}`);
    if (!(run.steps > 0)) own.push('STEPS_ZERO');
    if (!(run.actionsPass >= 1)) own.push('NO_EXPLORATION_ACTION_PASSED');
    let reason = 'PROBES_RAN';
    if (run.configuredRelations > 0) { if (!(run.probes > 0)) own.push('PROBES_ZERO_WITH_CONFIGURED_RELATIONS'); }
    else if (run.postComaExecuted > 0) reason = run.comaProvider === COMA_STANDIN_ID ? 'BLIND_POST_COMA_EXECUTED_WITH_STANDIN' : 'BLIND_POST_COMA_EXECUTED';
    else if (run.comaStatus === 'NOT_CONFIGURED') reason = 'BLIND_COMA_EXPLICITLY_NOT_CONFIGURED';
    else own.push('BLIND_UNIVERSE_WITHOUT_POST_COMA_OR_EXPLICIT_COMA_STATE');
    byUniverse[alias] = { passed: own.length === 0, reason: own.length ? own[0] : reason, failures: own };
    for (const code of own) failures.push({ alias, criterion: code, detail: `${alias} agent-loop: steps ${run.steps}, actions ${run.actionsPass}, probes ${run.probes}, postComa ${run.postComaExecuted}, coma ${run.comaStatus}` });
  }
  return { passed: failures.length === 0, failures, byUniverse };
}

/**
 * G1: every configured relation is a case of the evaluation. A relation the run did not probe, or probed without typed evidence, is NOT dropped from the total:
 * it becomes a case with no evidence (the policy abstains on it) so allCases, abstentions and coverage keep their honest denominator.
 */
export function notEvaluatedCases(fixture: AgentFixture, cfg: any, present: ReadonlySet<string>, inputSetHash: string): EvaluationCase[] {
  const manifest = resolveUniverseManifest(fixture.alias)!, version = manifest.version.split('.').slice(0, 2).join('.');
  return (cfg.relations ?? []).filter((relation: any) => !present.has(`${fixture.alias}:${relation.id}`)).map((relation: any): EvaluationCase => {
    const contract = legacyRelationContract(relation, manifest.manifestId, version, relation.normalization, relation.minDistinctKeys ?? 1), truth = fixture.adjudications[relation.id] ?? 'UNKNOWN';
    return { caseId: `${fixture.alias}:${relation.id}`, split: 'DEVELOPMENT', taskId: 'relation-support', universeId: manifest.manifestId, inputSetHash, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', contract, evidence: [],
      adjudication: { truth, basis: truth === 'UNKNOWN' ? 'DECLARED_CONTROL' : 'SYNTHETIC_FIXTURE', adjudicatorId: 'agent-eval-fixture', referenceHash: sha({ relationId: relation.id, truth }), adjudicatedAt: FROZEN_AT } };
  });
}

/** M4-4: selective prediction per universe and method. Pure arithmetic over the protocol's counts; the policy and the verdicts are untouched. */
export function selectiveMetrics(metric: { universeId: string; methodId: string; denominator: { allCases: number; accepts: number; adjudicatedAccepts: number }; counts: { falseAccept: number; rejects: number; abstentions: number } }) {
  const { allCases, accepts, adjudicatedAccepts } = metric.denominator, { falseAccept, rejects, abstentions } = metric.counts, decided = accepts + rejects;
  return { universeId: metric.universeId, methodId: metric.methodId, allCases, decided, coverage: allCases > 0 ? decided / allCases : null, abstentions, abstentionRate: allCases > 0 ? abstentions / allCases : null,
    adjudicatedAccepts, falseAccept, risk: adjudicatedAccepts > 0 ? falseAccept / adjudicatedAccepts : null, riskReason: adjudicatedAccepts > 0 ? null : 'NO_ADJUDICATED_ACCEPTS', unadjudicatedAccepts: accepts - adjudicatedAccepts };
}

/**
 * Regression evaluation of the whole agent loop through the shared L3-E protocol.
 * Offline, LOCAL + SYNTHETIC fixtures, no gold, no model, no network. Reports exact denominators per universe.
 */
export async function evaluateAgentLoop(options: { /** Test seam: treat the probe of this relation as having produced no typed evidence. */ withoutEvidence?: (alias: string, relationId: string) => boolean } = {}) {
  const policy = relationPolicyFromConfig(readJson('config/thresholds.json'));
  const enrollment = universeManifests.map(manifest => ({ manifestId: manifest.manifestId, alias: manifest.aliases[0], agentCapable: manifest.capabilities.includes('AGENT_EXPLORATION') }));
  const fixtures = agentFixtures();
  const cases: Record<string, EvaluationCase[]> = Object.fromEntries(METHODS.map(method => [method.methodId, []]));
  const runs: { method: string; alias: string; status: string; queries: number; steps: number; probes: number; exhausted: string[]; actionsPass: number; configuredRelations: number; comaStatus: string; postComaExecuted: number; comaProvider: string | null }[] = [];
  const skipped: { alias: string; reason: string }[] = [];
  for (const item of enrollment.filter(entry => entry.agentCapable)) if (!fixtures.some(fixture => fixture.alias === item.alias)) skipped.push({ alias: item.alias, reason: 'NO_OFFLINE_FIXTURE' });
  for (const fixture of fixtures) {
    const cfg = universeConfig(fixture.alias);
    for (const method of METHODS) {
      const report: any = await runAgent(fixture.alias, `agent-${fixture.alias.toLowerCase()}-eval-${method.methodId}`, { ...offlineAgentDeps(fixture.alias, fixture, method.explore ? new ScriptChooser([...fixture.chooserScript]) : undefined), persist: false, critic: true, now: () => FROZEN_AT });
      if (report.status === "DISCOVERY_FAILED") throw new Error("AGENT_EVAL_DISCOVERY_FAILED:" + JSON.stringify(report.phases.discovery));
      runs.push({ method: method.methodId, alias: fixture.alias, status: report.status, queries: report.budget.used.queries, steps: report.budget.used.steps, probes: report.phases.probes.selected.length, exhausted: report.budget.exhausted,
        actionsPass: (report.phases.exploration.actions ?? []).filter((item: any) => item.execution === 'PASS').length, configuredRelations: (cfg.relations ?? []).length, comaStatus: report.phases.coma.status, postComaExecuted: report.postComa?.counts?.executed ?? 0, comaProvider: (report.phases.coma.providerStates ?? []).some((state: any) => state?.providerId === COMA_STANDIN_ID) ? COMA_STANDIN_ID : null });
      for (const item of report.artifacts.probes) {
        const probe = item.evidence, relationId = item.relationId, evidence = probe.typedEvidence, contract = probe.relationContract;
        if (!evidence || !contract || options.withoutEvidence?.(fixture.alias, relationId)) continue; // filled below as a NOT_EVALUATED case: a configured relation without typed evidence stays in the denominator
        cases[method.methodId].push({ caseId: `${fixture.alias}:${relationId}`, split: 'DEVELOPMENT', taskId: 'relation-support', universeId: contract.universeRef.universeId, inputSetHash: sha({ alias: fixture.alias, tables: fixture.tables }),
          executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', contract, evidence: [evidence],
          adjudication: { truth: fixture.adjudications[relationId] ?? 'UNKNOWN', basis: fixture.adjudications[relationId] === 'UNKNOWN' || !fixture.adjudications[relationId] ? 'DECLARED_CONTROL' : 'SYNTHETIC_FIXTURE',
            adjudicatorId: 'agent-eval-fixture', referenceHash: sha({ relationId, truth: fixture.adjudications[relationId] }), adjudicatedAt: FROZEN_AT } });
      }
      cases[method.methodId].push(...notEvaluatedCases(fixture, cfg, new Set(cases[method.methodId].map(item => item.caseId)), sha({ alias: fixture.alias, tables: fixture.tables })));
    }
  }
  const inputSetHash = sha(fixtures.map(fixture => [fixture.alias, fixture.tables]));
  const allCases = cases[METHODS[0].methodId];
  const protocol = createEvaluationProtocol({ protocolVersion: '1.0', evaluatorVersion: '1.0.0', policyVersion: policy.policyVersion, codeHash: sha(['src/agent/engine.ts', 'src/eval/agent-eval.ts'].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8'))),
    policyHash: sha(policy), frozenAt: FROZEN_AT, developmentCaseIds: allCases.map(item => item.caseId), positiveEnumerationComplete: true,
    reservedHoldout: { manifestId: 'none-reserved', version: '1', contentHash: 'NONE', caseCount: 0, accessState: 'NOT_READ' } });
  const methodRuns: MethodRun[] = METHODS.map(method => ({ methodId: method.methodId, providerVersion: '1', inputSetHash: sha(inputSetHash), budget: { candidateLimit: allCases.length, reviewMinutes: 0 },
    cases: cases[method.methodId].map(item => ({ ...item, inputSetHash: sha(inputSetHash) })) }));
  const evaluation = evaluateDevelopment(protocol, methodRuns, policy);
  const selective = evaluation.metrics.map(metric => selectiveMetrics(metric));
  return { schemaVersion: 1, kind: 'AGENT_LOOP_OFFLINE_EVALUATION', mode: 'LOCAL', dataOrigin: 'SYNTHETIC', gold: 'NOT_USED', live: false,
    registry: { manifests: enrollment.length, agentCapable: enrollment.filter(entry => entry.agentCapable).length, evaluated: fixtures.length, notEnrolled: enrollment.filter(entry => !entry.agentCapable).map(entry => entry.alias), skipped },
    comaStandIn: { id: COMA_STANDIN_ID, universes: [...new Set(runs.filter(run => run.comaProvider).map(run => run.alias))].sort(), note: 'offline deterministic stand-in for COMA on blind universes; it is not COMA and proves wiring, not matching quality' },
    runs, evaluation, selective, criteria: agentLoopCriteria({ runs, skipped, agentCapable: enrollment.filter(entry => entry.agentCapable).map(entry => entry.alias), fixtures: fixtures.map(fixture => fixture.alias) }), limitations: [`Blind universes run with the offline COMA stand-in ${COMA_STANDIN_ID}, not COMA.`, 'Synthetic fixtures: metrics are regression signals for the loop, not product accuracy.', 'Adjudications are declared by fixture construction (or UNKNOWN); no reserved holdout is read.',
      'Universes without AGENT_EXPLORATION are reported as not enrolled, not as passed.'] };
}
