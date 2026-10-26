import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunStatus } from '../src/agent/run-status.ts';
import { liveExitCode, modelDidNotParticipate, runNotes, runWarnings } from '../src/agent/cli-run.ts';

const review = (extra: Record<string, unknown> = {}) => ({ status: 'APPLIED', health: { calls: 355, codes: [] }, ...extra });
const clean = (over: Record<string, unknown> = {}): any => ({ executionMode: 'LIVE', modelParticipation: 'USED', degradations: [], phases: { exploration: { status: 'DONE' }, candidateReview: review(), critic: { status: 'EVALUATED' } }, postComa: { status: 'EXECUTED' }, memory: { status: 'RECORDED', batch: { rejected: 0 } }, ...over });

test('a clean run is COMPLETED, with every core phase listed as complete', () => {
  const result = classifyRunStatus(clean());
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.phaseStatus.map(item => `${item.phase}:${item.role}:${item.state}`), ['discovery:core:COMPLETE', 'exploration:auxiliary:COMPLETE', 'postComa:core:COMPLETE', 'review:core:COMPLETE', 'memory:core:COMPLETE', 'critic:auxiliary:COMPLETE']);
  assert.match(result.statusExplanation, /^Corrida completa/);
});

test('R10 pass 1: exploration without the model but the review used it is COMPLETED_WITH_WARNINGS', () => {
  const report = clean({ modelParticipation: 'FAILED', modelParticipationReason: 'NETWORK_ERROR', degradations: [{ phase: 'exploration', code: 'NETWORK_ERROR' }, { phase: 'critic', code: 'CRITIC_SKIPPED' }], phases: { exploration: {}, candidateReview: review(), critic: { status: 'SKIPPED' } } });
  const result = classifyRunStatus(report);
  assert.equal(result.status, 'COMPLETED_WITH_WARNINGS');
  assert.deepEqual(result.warnings, [{ phase: 'exploration', code: 'NETWORK_ERROR' }]);
  assert.match(result.statusExplanation, /Núcleo completo \(descubrimiento, sondeo, revisión, memoria\)\. Advertencias en fases auxiliares: exploración \(NETWORK_ERROR\)/);
  assert.equal(modelDidNotParticipate({ ...report, status: result.status }, true), undefined);
  assert.equal(liveExitCode({ ...report, status: result.status }, true, true), 0);
});

test('R10 pass 2: a NOT_JSON exploration with a review that had nothing to review is COMPLETED_WITH_WARNINGS', () => {
  const report = clean({ degradations: [{ phase: 'exploration', code: 'MODEL_RESPONSE_NOT_JSON' }], phases: { exploration: {}, candidateReview: review({ status: 'NOTHING_APPROVED', health: { calls: 0, codes: [] } }), critic: { status: 'SKIPPED' } }, memory: { status: 'SKIPPED' } });
  const result = classifyRunStatus(report);
  assert.equal(result.status, 'COMPLETED_WITH_WARNINGS');
  assert.deepEqual(result.warnings, [{ phase: 'exploration', code: 'MODEL_RESPONSE_NOT_JSON' }]);
});

test('a degraded review is DEGRADED, even when the exploration also warned', () => {
  const report = clean({ degradations: [{ phase: 'exploration', code: 'MODEL_RESPONSE_NOT_JSON' }, { phase: 'review', code: 'REVIEW_INVALID_CALLS_OVER_THRESHOLD' }], phases: { exploration: {}, candidateReview: review({ health: { calls: 10, codes: ['REVIEW_INVALID_CALLS_OVER_THRESHOLD'] } }), critic: {} } });
  const result = classifyRunStatus(report);
  assert.equal(result.status, 'DEGRADED');
  assert.match(result.statusExplanation, /Núcleo degradado: revisión \(REVIEW_INVALID_CALLS_OVER_THRESHOLD\)\. Advertencias en fases auxiliares: exploración/);
  assert.equal(classifyRunStatus(clean({ phases: { candidateReview: { status: 'FAILED' } } })).status, 'DEGRADED');
});

test('the model missing from the review is DEGRADED_NO_MODEL, an exploration failure alone is not', () => {
  const pending = clean({ modelParticipation: 'FAILED', modelParticipationReason: 'NO_MODEL_CALLS', phases: { exploration: {}, candidateReview: review({ status: 'APPLIED', health: { calls: 0, codes: [] }, counts: { candidates: 5, reused: 1, reusedNegative: 1, reviewed: 3, notReviewed: 0 } }) } });
  assert.equal(classifyRunStatus(pending).status, 'DEGRADED_NO_MODEL', 'reviewed > 0 with 0 valid calls');
  const budget = clean({ modelParticipation: 'FAILED', phases: { exploration: {}, candidateReview: review({ status: 'APPLIED', health: { calls: 0, codes: [], skippedBudgetCalls: 4 }, counts: { candidates: 5, reviewed: 0, notReviewed: 5 } }) } });
  assert.equal(classifyRunStatus(budget).status, 'DEGRADED_NO_MODEL', 'skippedBudget > 0 with 0 calls');
  const reused = clean({ modelParticipation: 'FAILED', modelParticipationReason: 'NETWORK_ERROR', degradations: [{ phase: 'exploration', code: 'NETWORK_ERROR' }], phases: { exploration: {}, candidateReview: review({ status: 'APPLIED', health: { calls: 0, codes: [] }, counts: { candidates: 1466, reused: 92, reusedNegative: 90, reviewed: 0, notReviewed: 1284 } }) } });
  assert.equal(classifyRunStatus(reused).status, 'COMPLETED_WITH_WARNINGS', 'pass 2: memory-resolved plus gate-held candidates never asked for the model');
  assert.equal(classifyRunStatus(clean({ modelParticipation: 'FAILED', phases: { exploration: {}, candidateReview: review({ status: 'SKIPPED_NO_REVIEWER' }) } })).status, 'DEGRADED_NO_MODEL');
  const none = clean({ modelParticipation: 'FAILED', phases: { exploration: {}, candidateReview: review({ status: 'NOTHING_APPROVED', health: { calls: 0, codes: [] } }) } });
  assert.equal(classifyRunStatus(none).status, 'COMPLETED_WITH_WARNINGS', 'no candidates: the model was not needed');
  assert.equal(classifyRunStatus(clean({ modelParticipation: 'FAILED', phases: { exploration: {} } })).status, 'DEGRADED_NO_MODEL', 'no review stage and no model');
  assert.equal(liveExitCode({ status: 'DEGRADED_NO_MODEL', modelParticipation: 'FAILED' }, true, true), 1);
});

test('core COMA_FAILED and a quarantined memory are DEGRADED', () => {
  assert.equal(classifyRunStatus(clean({ postComa: { status: 'COMA_FAILED' } })).status, 'DEGRADED');
  const quarantined = classifyRunStatus(clean({ memory: { status: 'RECORDED', batch: { rejected: 2 } }, degradations: [{ phase: 'memory', code: 'MEMORY_CLAIMS_QUARANTINED' }] }));
  assert.equal(quarantined.status, 'DEGRADED');
  assert.match(quarantined.statusExplanation, /memoria \(MEMORY_CLAIMS_QUARANTINED\)/);
  assert.equal(classifyRunStatus(clean({ memory: { status: 'ERROR' } })).status, 'DEGRADED');
});

test('informational degradations never change the status; a critic ERROR is only a warning; hard statuses stay', () => {
  assert.equal(classifyRunStatus(clean({ modelParticipation: 'NOT_REQUESTED', degradations: [{ phase: 'exploration', code: 'NO_MODEL_REQUESTED' }, { phase: 'budget', code: 'BUDGET_EXHAUSTED_STEPS' }], phases: { exploration: {}, candidateReview: review(), critic: { status: 'SKIPPED' } } })).status, 'COMPLETED');
  assert.equal(classifyRunStatus(clean({ phases: { exploration: {}, candidateReview: review(), critic: { status: 'ERROR' } } })).status, 'COMPLETED_WITH_WARNINGS');
  for (const status of ['FAILED', 'PARTIAL', 'DISCOVERY_FAILED']) assert.equal(classifyRunStatus(clean({ status })).status, status);
  assert.equal(classifyRunStatus(clean(), { explorationDegraded: true }).status, 'COMPLETED_WITH_WARNINGS');
});

test('CLI: COMPLETED_WITH_WARNINGS exits 0 and prints NOTE: warnings, not WARNING', () => {
  const report = { status: 'COMPLETED_WITH_WARNINGS', modelParticipation: 'FAILED', degradations: [{ phase: 'exploration', code: 'X' }], phaseStatus: [{ phase: 'exploration', role: 'auxiliary', state: 'DEGRADED', codes: ['MODEL_RESPONSE_NOT_JSON'] }] };
  assert.equal(liveExitCode(report, true, true), 0);
  assert.equal(liveExitCode(report, true, false), 1, 'ledger prefix changed still fails');
  assert.deepEqual(runWarnings(report, true), []);
  assert.deepEqual(runNotes(report), ['NOTE: warnings(exploration:MODEL_RESPONSE_NOT_JSON)']);
  assert.equal(liveExitCode({ status: 'DEGRADED', modelParticipation: 'USED' }, true, true), 1);
});
