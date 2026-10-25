import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readBudget } from '../budget.ts';
import { readJson, ROOT, SafeError, setTraceRun, trace, writeJson } from '../runtime.ts';
import type { ActionChooser } from './chooser.ts';
import { AGENT_RUN_ID, describedColumns, prepareAgentContext, type AgentDeps } from './engine.ts';
import { runExploration, type ExplorationRead } from './exploration.ts';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * One-shot compact continuation of an exploration that stopped on an invalid model decision or on a failed model call (transport).
 * Reserves the run first (an interrupted attempt cannot be charged twice), makes exactly one compact decision,
 * runs at most the one permitted bounded read, and never repeats a failed continuation.
 * Probes and decisions already recorded by the run are not recomputed.
 */
export async function continueAgentExploration(universe: string, runId: string, deps: Pick<AgentDeps, 'client'> & { chooser: ActionChooser }, attempt = 1) {
  if (attempt !== 1 && attempt !== 2) throw new SafeError('AGENT_CONTINUATION_ATTEMPT_INVALID');
  if (!AGENT_RUN_ID.test(runId)) throw new SafeError('AGENT_RUN_ID_INVALID');
  const prefix = `.concordia/agent-runs/${runId}/`, directory = path.join(ROOT, prefix);
  if (!fs.existsSync(path.join(directory, 'engine-run.json'))) throw new SafeError('AGENT_RUN_NOT_FOUND');
  const report = readJson<any>(prefix + 'engine-run.json');
  const calls = report.phases?.exploration?.calls ?? [];
  const last = calls[calls.length - 1];
  // Continuable: the last decision was rejected (INVALID_RESPONSE) or the model call itself failed in transport (no decision was made).
  const transportFailure = last?.status === 'FAIL' && last.decisionStatus === undefined;
  if (report.status !== 'COMPLETED' || report.executionMode !== 'LIVE' || (last?.decisionStatus !== 'INVALID_RESPONSE' && !transportFailure)) throw new SafeError('AGENT_RUN_NOT_CONTINUABLE');
  const ctx = prepareAgentContext(universe, runId, { client: deps.client, executionMode: 'LIVE' });
  if (report.universeId !== ctx.universeId) throw new SafeError('AGENT_RUN_SCOPE_MISMATCH');
  // Attempt 2 exists only for an explicit human re-authorization after a failed attempt 1; there is no attempt 3.
  const suffix = attempt === 1 ? '' : '-2', previousFile = path.join(directory, 'continuation.json');
  let previous: any;
  if (attempt === 2) {
    if (!fs.existsSync(previousFile)) throw new SafeError('AGENT_CONTINUATION_PREVIOUS_ATTEMPT_MISSING');
    previous = readJson<any>(prefix + 'continuation.json');
    if (previous.outcome !== 'DECISION_OR_READ_FAILED') throw new SafeError('AGENT_CONTINUATION_PREVIOUS_NOT_FAILED');
  }
  // Reserve before any model call: a repeated attempt, interrupted or not, is refused.
  try { fs.writeFileSync(path.join(directory, `continuation${suffix}.lock`), JSON.stringify({ utc: new Date().toISOString(), runId }) + '\n', { flag: 'wx' }); }
  catch { throw new SafeError('AGENT_CONTINUATION_ALREADY_RESERVED'); }
  setTraceRun(runId);
  const discovery = readJson<any>(prefix + 'discovery.json');
  const reads: Record<string, ExplorationRead> = {};
  for (const file of fs.readdirSync(directory).filter(name => /^adaptive-read-.*\.json$/.test(name))) { const read = readJson<ExplorationRead>(prefix + file); reads[read.actionId] = read; }
  // Queries and tokens accumulate across attempts; a rejected decision takes no exploration step (no action was taken).
  const used = (previous ?? report).budget.used;
  Object.assign(ctx.budget, { queries: used.queries, tokens: used.tokens, steps: report.phases.exploration.actions.length });
  const before = readBudget(), beforePrefix = sha(before.attempts);
  const priorActions = report.phases.exploration.actions;
  const exploration = await runExploration({ runId, cfg: ctx.cfg, catalog: ctx.catalog, discovery, sourceColumns: describedColumns(discovery), client: ctx.client, chooser: deps.chooser, budget: ctx.budget,
    extraObservation: report.phases.coma?.outOfScopeProposals ?? [], executionMode: 'LIVE', dataOrigin: ctx.dataOrigin, persistPrefix: prefix, compact: true, maxNewSteps: 1,
    resume: { reads, actions: priorActions, attempted: priorActions.filter((item: any) => item.execution !== 'NOT_REQUIRED').map((item: any) => item.action), firstStep: report.phases.exploration.actions.length + 1 } });
  const after = readBudget();
  const outcome = exploration.plannerError ? 'DECISION_OR_READ_FAILED' : exploration.actions.length > priorActions.length ? 'COMPLETED' : 'NO_ACTION';
  const record = { schemaVersion: 1, runId, attempt, universeId: ctx.universeId, executionMode: 'LIVE', dataOrigin: ctx.dataOrigin, utc: new Date().toISOString(), outcome,
    newActions: exploration.actions.slice(priorActions.length), call: exploration.calls.map(({ responseText: _text, ...call }) => call)[0] ?? null, plannerError: exploration.plannerError ?? null,
    reads: Object.fromEntries(Object.entries(exploration.reads).map(([id, read]) => [id, { rows: read.rows.length, columns: read.columns, queryId: read.queryId }])),
    budget: ctx.budget.snapshot(), ledger: { attemptsBefore: before.consumed, attemptsAfter: after.consumed, attemptsAdded: after.consumed - before.consumed, priorAttemptsPreserved: sha(after.attempts.slice(0, before.attempts.length)) === beforePrefix },
    limitations: ['Single compact continuation; no further attempt is made, valid or not.', 'Earlier probes and decisions are kept as recorded; they are not recomputed from the new read.'] };
  writeJson(`${prefix}continuation${suffix}.json`, record);
  trace({ kind: 'agent-continuation-complete', runId, outcome, budget: record.budget });
  return record;
}
