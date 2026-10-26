/**
 * E5-02 on tool-call (probe 3a: the gateway ignores `response_format` json_schema, a forced tool call works). The two answers of the reviewer as function schemas; the arguments of the
 * call are the JSON the existing strict parsers already read, so nothing is repaired and nothing is retried. The schema is closed (additionalProperties false) and mirrors the parsers.
 */
import { createHash } from 'node:crypto';
import { ESTIMATE_CHARS_PER_TOKEN } from '../run-budget.ts';
import { TOOL_CALL_SMALL_FUNCTION_TOKENS } from './calibration.ts';
import { CONFIDENCES, DECISIONS, MODEL_ATTACK_FAMILIES, REASON_CODES, type TraceStage } from './types.ts';

export const TOOL_SCHEMA_VERSION = 'model-review-tools-v2';
export const EVALUATION_TOOL_NAME = 'submit_evaluation', ATTACKS_TOOL_NAME = 'submit_attacks';
const MAX_REASON_CODES = 8, MAX_EVIDENCE_REFS = 3;

export interface ReviewTool { type: 'function'; function: { name: string; description: string; parameters: object } }

const EVALUATION_TOOL: ReviewTool = { type: 'function', function: {
  name: EVALUATION_TOOL_NAME,
  description: 'Submit the evaluation of the candidate relation.',
  parameters: { type: 'object', additionalProperties: false, required: ['relationId', 'decision', 'confidence', 'reasonCodes', 'rationale'], properties: {
    relationId: { type: 'string' },
    decision: { type: 'string', enum: [...DECISIONS] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    reasonCodes: { type: 'array', description: 'A JSON array of reason-code strings, not a string.', minItems: 1, maxItems: MAX_REASON_CODES, uniqueItems: true, items: { type: 'string', enum: [...REASON_CODES] } },
    rationale: { type: 'string', maxLength: 300 } } } } };

const ATTACKS_TOOL: ReviewTool = { type: 'function', function: {
  name: ATTACKS_TOOL_NAME,
  description: 'Submit the attacks on the evaluations: one entry per family.',
  parameters: { type: 'object', additionalProperties: false, required: ['relationId', 'attacks'], properties: {
    relationId: { type: 'string' },
    attacks: { type: 'array', description: 'A JSON array of exactly two attack objects, not a string containing JSON.', minItems: MODEL_ATTACK_FAMILIES.length, maxItems: MODEL_ATTACK_FAMILIES.length, items: { type: 'object', additionalProperties: false, required: ['family', 'severity', 'recommend', 'argument', 'evidenceRefs'], properties: {
      family: { type: 'string', enum: [...MODEL_ATTACK_FAMILIES] },
      severity: { type: 'string', enum: ['none', 'minor', 'blocking'] },
      recommend: { type: 'string', enum: ['keep', 'defer', 'reject'] },
      argument: { type: 'string', maxLength: 200 },
      evidenceRefs: { type: 'array', description: 'A JSON array of strings, not a string.', maxItems: MAX_EVIDENCE_REFS, items: { type: 'string', maxLength: 60 } } } } } } } } };

export const toolFor = (stage: TraceStage): ReviewTool => (stage === 'EVALUATION' ? EVALUATION_TOOL : ATTACKS_TOOL);
/** What `Nightshift.chat` takes: the one tool and a `tool_choice` that names it, so the model has to answer through it. */
export const toolRequest = (stage: TraceStage) => ({ tools: [toolFor(stage)] as object[], toolChoice: { type: 'function', function: { name: toolFor(stage).function.name } } as object });
export const toolSchemaHash = (stage: TraceStage) => createHash('sha256').update(JSON.stringify(toolFor(stage))).digest('hex');

/** Upper bound the budget gate adds to a call that sends the tool: the 3a overhead of a small function plus the schema itself at the gate's own ratio (it counts a little twice; it never under-counts). */
export const toolSchemaTokens = (stage: TraceStage) => TOOL_CALL_SMALL_FUNCTION_TOKENS + Math.ceil(JSON.stringify(toolFor(stage)).length / ESTIMATE_CHARS_PER_TOKEN);

/** Offline measurement of what the schemas add to the input of each stage, for the decision on adopting the tool-call transport. No call is made. */
export function measureToolCost() {
  return (['EVALUATION', 'ATTACK'] as const).map(stage => {
    const chars = JSON.stringify(toolFor(stage)).length;
    return { stage, tool: toolFor(stage).function.name, schemaChars: chars, schemaTokensAtGateRatio: Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN), schemaTokensAt3_5Chars: Math.ceil(chars / 3.5), gateAddsTokens: toolSchemaTokens(stage), smallFunctionMeasuredLive: TOOL_CALL_SMALL_FUNCTION_TOKENS };
  });
}
