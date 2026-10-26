// Run status taxonomy: core phases decide DEGRADED / DEGRADED_NO_MODEL, auxiliary phases only add warnings (COMPLETED_WITH_WARNINGS).
// Core: discovery, post-COMA (probing and coverage), candidate review, memory. Auxiliary: exploration (and secondary judge), critic (and critic assist), informational budget.
// Pure: it reads a finished engine report, so the same rule classifies a saved engine-run.json.
export type RunStatus = 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'DEGRADED' | 'DEGRADED_NO_MODEL' | 'PARTIAL' | 'FAILED' | 'DISCOVERY_FAILED';
export type PhaseState = 'COMPLETE' | 'DEGRADED' | 'SKIPPED' | 'NOT_APPLICABLE';
export interface PhaseStatusEntry { phase: string; role: 'core' | 'auxiliary'; state: PhaseState; codes?: string[] }
export interface RunClassification { status: RunStatus; phaseStatus: PhaseStatusEntry[]; statusExplanation: string; warnings: { phase: string; code: string }[] }

/** Statuses decided by a hard stop (a failed probe stage, an unhealthy memory batch): the taxonomy never overrides them. */
const HARD_STATUSES = new Set(['FAILED', 'PARTIAL', 'DISCOVERY_FAILED']);
const NAMES: Record<string, string> = { discovery: 'descubrimiento', exploration: 'exploración', postComa: 'sondeo', review: 'revisión', critic: 'crítico', memory: 'memoria' };
const EXPLORATION_INFORMATIONAL = new Set(['NO_MODEL_REQUESTED', 'SECONDARY_JUDGE_NO_MODEL', 'AGENT_TOKEN_BUDGET_EXHAUSTED', 'TOKEN_BUDGET_WOULD_EXCEED', 'AGENT_CHOOSER_UNAVAILABLE']);

const codesOf = (report: any, ...phases: string[]): string[] => [...new Set<string>((report.degradations ?? []).filter((item: any) => phases.includes(item?.phase)).map((item: any) => String(item.code)))];

/**
 * Classifies a finished run. `hints.explorationDegraded` is the engine's own flag (a failed read or a non-budget planner error); without it the same
 * conclusion is derived from the exploration degradations, so a saved report classifies the same way.
 */
export function classifyRunStatus(report: any, hints: { explorationDegraded?: boolean } = {}): RunClassification {
  const live = report.executionMode === 'LIVE', section = report.phases?.candidateReview as { status?: string; health?: { calls?: number; codes?: string[]; skippedBudgetCalls?: number }; counts?: { reviewed?: number }; consistency?: { status?: string } } | undefined;
  const entries: PhaseStatusEntry[] = [];
  const add = (phase: string, role: 'core' | 'auxiliary', state: PhaseState, codes: string[] = []) => entries.push({ phase, role, state, ...(codes.length ? { codes } : {}) });

  add('discovery', 'core', 'COMPLETE');

  const modelFailed = report.modelParticipation === 'FAILED';
  const explorationCodes = codesOf(report, 'exploration').filter(code => !EXPLORATION_INFORMATIONAL.has(code) && code !== 'SECONDARY_JUDGE_NO_MODEL');
  const readOnlyKnown = report.modelParticipation === 'NOT_REQUESTED' || report.modelParticipation === 'SCRIPTED_OFFLINE';
  const explorationDegraded = modelFailed || (hints.explorationDegraded ?? (readOnlyKnown ? explorationCodes.includes('EXPLORATION_READ_FAILED') : explorationCodes.length > 0));
  if (!report.phases?.exploration) add('exploration', 'auxiliary', 'NOT_APPLICABLE');
  else if (explorationDegraded) add('exploration', 'auxiliary', 'DEGRADED', modelFailed && report.modelParticipationReason ? [String(report.modelParticipationReason), ...explorationCodes.filter(code => code !== report.modelParticipationReason)] : explorationCodes);
  else add('exploration', 'auxiliary', 'COMPLETE');

  const comaFailed = report.postComa?.status === 'COMA_FAILED';
  if (!report.postComa) add('postComa', 'core', 'NOT_APPLICABLE');
  else add('postComa', 'core', comaFailed ? 'DEGRADED' : 'COMPLETE', comaFailed ? ['COMA_FAILED'] : []);

  const reviewHealthCodes = section?.health?.codes ?? [];
  const reviewDegraded = Boolean(section && (section.status === 'FAILED' || (section.status === 'SKIPPED_NO_REVIEWER' && live) || reviewHealthCodes.length || section.consistency?.status === 'ERROR'));
  if (!section) add('review', 'core', 'NOT_APPLICABLE');
  else if (reviewDegraded) add('review', 'core', 'DEGRADED', codesOf(report, 'review'));
  else if (section.status === 'SKIPPED_NO_REVIEWER' || section.status === 'NOT_APPLIED') add('review', 'core', 'SKIPPED', codesOf(report, 'review'));
  else add('review', 'core', 'COMPLETE');
  // The model took part in the review when it made calls and the review did not fail or get skipped.
  const reviewUsedModel = Boolean(section && !['FAILED', 'SKIPPED_NO_REVIEWER', 'NOT_APPLIED'].includes(String(section.status)) && Number(section.health?.calls ?? 0) > 0);
  // The review NEEDED the model when it could not run, or when candidates were left that memory (reuse, N2) did not resolve. A review that ended with 0 calls because
  // nothing asked for the model (everything reused, no candidates) did not need it: an exploration failure alone is then a warning.
  const counts = section?.counts;
  // Candidates held by the review gate (notReviewed), the floor and memory (reused, reusedNegative) never ask for the model; only those that entered the model review
  // (counts.reviewed) or were cut by the budget (health.skippedBudgetCalls) did. Without counts: any review that is not NOTHING_APPROVED.
  const unresolved = counts ? Number(counts.reviewed ?? 0) + Number(section?.health?.skippedBudgetCalls ?? 0) : section && section.status !== 'NOTHING_APPROVED' ? 1 : 0;
  const reviewNeededModel = Boolean(section && (['FAILED', 'SKIPPED_NO_REVIEWER', 'NOT_APPLIED'].includes(String(section.status)) || unresolved > 0));

  const memory = report.memory as { status?: string; batch?: { rejected?: number } } | undefined;
  const memoryDegraded = Boolean(memory && (memory.status === 'ERROR' || Number(memory.batch?.rejected ?? 0) > 0));
  if (!memory) add('memory', 'core', 'NOT_APPLICABLE');
  else if (memoryDegraded) add('memory', 'core', 'DEGRADED', codesOf(report, 'memory'));
  else if (memory.status === 'SKIPPED') add('memory', 'core', 'SKIPPED');
  else add('memory', 'core', 'COMPLETE');

  const critic = report.phases?.critic?.status;
  if (!report.phases?.critic) add('critic', 'auxiliary', 'NOT_APPLICABLE');
  else if (critic === 'ERROR') add('critic', 'auxiliary', 'DEGRADED', codesOf(report, 'critic'));
  else if (['SKIPPED', 'DISABLED'].includes(critic)) add('critic', 'auxiliary', 'SKIPPED', codesOf(report, 'critic'));
  else add('critic', 'auxiliary', 'COMPLETE');

  const core = entries.filter(item => item.role === 'core'), aux = entries.filter(item => item.role === 'auxiliary');
  const coreDegraded = core.filter(item => item.state === 'DEGRADED'), auxDegraded = aux.filter(item => item.state === 'DEGRADED');
  const warnings = auxDegraded.flatMap(item => (item.codes?.length ? item.codes : ['UNSPECIFIED']).map(code => ({ phase: item.phase, code })));
  const list = (items: PhaseStatusEntry[]) => items.map(item => `${NAMES[item.phase] ?? item.phase} (${(item.codes?.length ? item.codes : ['UNSPECIFIED']).join(', ')})`).join(', ');
  const completeCore = core.filter(item => item.state === 'COMPLETE').map(item => NAMES[item.phase]).join(', ');

  const base = HARD_STATUSES.has(report.status) ? report.status as RunStatus : undefined;
  let status: RunStatus, statusExplanation: string;
  if (base) { status = base; statusExplanation = `La corrida terminó ${base}: ${report.status === 'FAILED' ? 'un fallo de núcleo impidió escribir resultados confiables' : 'una etapa no se completó'}.`; }
  else if (modelFailed && (!section || (reviewNeededModel && !reviewUsedModel))) {
    status = 'DEGRADED_NO_MODEL';
    statusExplanation = `El modelo no participó donde es núcleo (revisión de candidatas): ${report.modelParticipationReason ?? 'sin llamadas del modelo'}.${coreDegraded.length ? ` Núcleo degradado: ${list(coreDegraded)}.` : ''}`;
  } else if (coreDegraded.length) {
    status = 'DEGRADED';
    statusExplanation = `Núcleo degradado: ${list(coreDegraded)}.${auxDegraded.length ? ` Advertencias en fases auxiliares: ${list(auxDegraded)}.` : ''}`;
  } else if (auxDegraded.length) {
    status = 'COMPLETED_WITH_WARNINGS';
    statusExplanation = `Núcleo completo${completeCore ? ` (${completeCore})` : ''}. Advertencias en fases auxiliares: ${list(auxDegraded)}.`;
  } else {
    status = 'COMPLETED';
    statusExplanation = `Corrida completa${completeCore ? `: núcleo (${completeCore}) sin degradaciones` : ''}.`;
  }
  return { status, phaseStatus: entries, statusExplanation, warnings };
}
