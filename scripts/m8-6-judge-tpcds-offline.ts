// M8-6 (measurement only, offline): reads agent-run artifacts as data and replays them through the secondary-judge harness. No model call, no source query, no network.
// Usage: node scripts/run-tsx.mjs scripts/m8-6-judge-tpcds-offline.ts [runs-dir] [runId runId ...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateSecondaryJudge, validateLabelledSet, type SecondaryJudge } from '../src/agent/secondary-judge.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';

const DEFAULT_RUNS = ['agent-tpcds-live-01', 'agent-tpcds-live-02'];
const tally = <T>(items: T[], key: (item: T) => string) => items.reduce<Record<string, number>>((acc, item) => { const k = key(item); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

export async function measureJudgeOffline(dir: string, runs: string[] = DEFAULT_RUNS) {
  let judgeCalls = 0, innerCalls = 0;
  const judge: SecondaryJudge = { judge: async () => { judgeCalls++; throw new Error('OFFLINE_NO_MODEL_CALL'); } };
  const inner = { choose: async () => { innerCalls++; throw new Error('OFFLINE_NO_MODEL_CALL'); } } as unknown as ActionChooser;
  const budget = { canAskModel: () => true, canAfford: () => true, chargeTokens: () => {} } as any;
  const out: any = { mode: 'OFFLINE_REPLAY', runs: {} };
  const ids: Record<string, Set<string>> = {};
  for (const run of runs) {
    const engine = JSON.parse(fs.readFileSync(path.join(dir, run, 'engine-run.json'), 'utf8'));
    const executed = ((engine.postComa?.proposals ?? []) as any[]).filter(p => p.coverageProbe?.status === 'EXECUTED');
    ids[run] = new Set(executed.map(p => p.proposalId));
    const d = (p: any) => p.coverageProbe.diagnostic;
    const calls: any[] = engine.phases?.exploration?.calls ?? [];
    // Every recorded elector call goes through the real eligibility gate (flag ON, a judge that fails if called). The artifacts do not persist the allowed-id list.
    const electorReplay: any[] = [];
    for (const call of calls) {
      const note = await evaluateSecondaryJudge({ enabled: true, judge, budget, k: 0, seedBase: run }, inner, call as ChoiceCall, {}, []);
      electorReplay.push({ stage: call.stage, decisionStatus: call.decisionStatus, selected: call.selected ?? null, tokens: call.receipt?.totalTokens ?? null, judgeNote: note?.status ?? 'NOT_ELIGIBLE' });
    }
    out.runs[run] = {
      status: engine.status, modelParticipation: engine.modelParticipation ?? 'NOT_RECORDED', plannerError: engine.phases?.exploration?.plannerError?.code ?? null,
      proposals: engine.postComa?.proposals?.length ?? 0, executedCoverageProbes: executed.length,
      electorCalls: calls.length, electorValid: calls.filter(c => c.decisionStatus === 'VALID').length, electorReplay,
      deterministicDiagnosis: {
        suspect: tally(executed, p => String(d(p).suspect.value)), suspectReasons: tally(executed.flatMap(p => d(p).suspect.reasons as string[]), x => x),
        labelSignal: tally(executed, p => d(p).labels.signal), coverageLevel: tally(executed, p => d(p).coverage.level), inclusion: tally(executed, p => d(p).keyRules.inclusion.status),
        targetUniqueness: tally(executed, p => d(p).keyRules.targetUniqueness.status), governance: tally(executed, p => d(p).governance)
      },
      suspectOrNotComparable: executed.filter(p => d(p).suspect.value === true || d(p).labels.signal === 'NOT_COMPARABLE').length
    };
  }
  if (runs.length === 2) out.overlapExecutedCandidates = { [runs[0]]: ids[runs[0]].size, [runs[1]]: ids[runs[1]].size, common: [...ids[runs[0]]].filter(id => ids[runs[1]].has(id)).length };
  out.labelledSet = { cases: 0, issues: validateLabelledSet({ schemaVersion: 1, cases: [] }), measurement: 'NOT_COMPUTABLE: no human-labelled case and no recorded judge answer exist for these artifacts' };
  out.modelCalls = { judge: judgeCalls, elector: innerCalls, tokensSpentByThisScript: 0 };
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir = '.concordia/agent-runs', ...runs] = process.argv.slice(2);
  console.log(JSON.stringify(await measureJudgeOffline(dir, runs.length ? runs : DEFAULT_RUNS), null, 2));
}
