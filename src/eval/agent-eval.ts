import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ActionChooser, type ChoiceCall } from '../agent/chooser.ts';
import { runAgent } from '../agent/engine.ts';
import { universeManifests } from '../registry/universes.ts';
import { readJson, ROOT } from '../runtime.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { universeConfig } from '../universe-pipeline.ts';
import { catalogOf } from '../agent/catalog.ts';
import { fixtureClient, fixtureTablesFromConfig, type AgentFixture } from './fixture-client.ts';
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

/**
 * Regression evaluation of the whole agent loop through the shared L3-E protocol.
 * Offline, LOCAL + SYNTHETIC fixtures, no gold, no model, no network. Reports exact denominators per universe.
 */
export async function evaluateAgentLoop() {
  const policy = relationPolicyFromConfig(readJson('config/thresholds.json'));
  const enrollment = universeManifests.map(manifest => ({ manifestId: manifest.manifestId, alias: manifest.aliases[0], agentCapable: manifest.capabilities.includes('AGENT_EXPLORATION') }));
  const fixtures = agentFixtures();
  const cases: Record<string, EvaluationCase[]> = Object.fromEntries(METHODS.map(method => [method.methodId, []]));
  const runs: { method: string; alias: string; status: string; queries: number; steps: number; probes: number; exhausted: string[] }[] = [];
  const skipped: { alias: string; reason: string }[] = [];
  for (const item of enrollment.filter(entry => entry.agentCapable)) if (!fixtures.some(fixture => fixture.alias === item.alias)) skipped.push({ alias: item.alias, reason: 'NO_OFFLINE_FIXTURE' });
  for (const fixture of fixtures) {
    const cfg = universeConfig(fixture.alias);
    for (const method of METHODS) {
      const report: any = await runAgent(fixture.alias, `agent-${fixture.alias.toLowerCase()}-eval-${method.methodId}`, { client: fixtureClient(cfg, fixture.tables) as any,
        chooser: method.explore ? new ScriptChooser([...fixture.chooserScript]) : undefined, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true, now: () => FROZEN_AT });
      if (report.status === "DISCOVERY_FAILED") throw new Error("AGENT_EVAL_DISCOVERY_FAILED:" + JSON.stringify(report.phases.discovery));
      runs.push({ method: method.methodId, alias: fixture.alias, status: report.status, queries: report.budget.used.queries, steps: report.budget.used.steps, probes: report.phases.probes.selected.length, exhausted: report.budget.exhausted });
      for (const item of report.artifacts.probes) {
        const probe = item.evidence, relationId = item.relationId, evidence = probe.typedEvidence, contract = probe.relationContract;
        if (!evidence || !contract) continue;
        cases[method.methodId].push({ caseId: `${fixture.alias}:${relationId}`, split: 'DEVELOPMENT', taskId: 'relation-support', universeId: contract.universeRef.universeId, inputSetHash: sha({ alias: fixture.alias, tables: fixture.tables }),
          executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', contract, evidence: [evidence],
          adjudication: { truth: fixture.adjudications[relationId] ?? 'UNKNOWN', basis: fixture.adjudications[relationId] === 'UNKNOWN' || !fixture.adjudications[relationId] ? 'DECLARED_CONTROL' : 'SYNTHETIC_FIXTURE',
            adjudicatorId: 'agent-eval-fixture', referenceHash: sha({ relationId, truth: fixture.adjudications[relationId] }), adjudicatedAt: FROZEN_AT } });
      }
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
  return { schemaVersion: 1, kind: 'AGENT_LOOP_OFFLINE_EVALUATION', mode: 'LOCAL', dataOrigin: 'SYNTHETIC', gold: 'NOT_USED', live: false,
    registry: { manifests: enrollment.length, agentCapable: enrollment.filter(entry => entry.agentCapable).length, evaluated: fixtures.length, notEnrolled: enrollment.filter(entry => !entry.agentCapable).map(entry => entry.alias), skipped },
    runs, evaluation, limitations: ['Synthetic fixtures: metrics are regression signals for the loop, not product accuracy.', 'Adjudications are declared by fixture construction (or UNKNOWN); no reserved holdout is read.',
      'Universes without AGENT_EXPLORATION are reported as not enrolled, not as passed.'] };
}
