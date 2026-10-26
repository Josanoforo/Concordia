/**
 * Live model client of the reviewer: the same Nightshift chat the elector and the secondary judge use (src/llm-completion.ts family, pattern of
 * secondary-judge.ts). One `NightshiftReviewModel` per role; pass a different `route` for the adversary when the account offers one, so the judges
 * and the adversary do not share a model. Constructing it makes no call; only `complete` does, and the reviewer checks the budget before each.
 *
 * E5-02: with `structuredOutput: 'TOOL_CALL'` the answer is requested as a forced tool call (`tools` + a `tool_choice` that names the function), the only structured-output route the
 * gateway honours (probe 3a: `response_format` json_schema is ignored). The arguments of the call come back as the response text and go through the same strict parsers; there is no repair
 * and no retry. The schema adds input tokens to every call (see `measureToolCost`). A model built directly defaults to plain text; `createCandidateReview` asks for the tool call by default.
 */
import { NightshiftChatError, type Nightshift } from '../../clients/nightshift.ts';
import { estimateMessagesTokens } from './prompts.ts';
import { toolRequest, toolSchemaTokens } from './tool-schemas.ts';
import type { CallTransport, ModelMessage, ReviewCall, ReviewModel, TraceStage } from './types.ts';

export interface NightshiftReviewModelOptions { route?: string; structuredOutput?: 'TOOL_CALL' | 'NONE' }

export class NightshiftReviewModel implements ReviewModel {
  readonly kind = 'LIVE_MODEL' as const;
  get requestedModel() { return this.options.route ?? this.nightshift.route; }
  get transport(): CallTransport { return this.options.structuredOutput === 'TOOL_CALL' ? 'TOOL_CALL' : 'TEXT'; }
  constructor(readonly id: string, private readonly nightshift: Nightshift, private readonly options: NightshiftReviewModelOptions = {}) {}
  estimateTokens(messages: readonly ModelMessage[], maxOutputTokens: number, stage?: TraceStage) {
    return estimateMessagesTokens(messages, maxOutputTokens) + (this.transport === 'TOOL_CALL' && stage ? toolSchemaTokens(stage) : 0);
  }
  async complete(messages: readonly ModelMessage[], options: { maxOutputTokens: number; stage?: TraceStage }): Promise<ReviewCall> {
    const tool = this.transport === 'TOOL_CALL' && options.stage ? toolRequest(options.stage) : undefined;
    try {
      const generated = await this.nightshift.chat([...messages], { maxTokens: options.maxOutputTokens, preserveTextOnFailure: true, ...(this.options.route ? { route: this.options.route } : {}), ...(tool ? tool : {}) });
      // A forced tool call that still answered in text is read as text: the parsers decide, and the record says which transport it was.
      return { status: 'PASS', responseText: generated.text, receipt: generated.receipt, truncated: generated.truncated === true, ...(tool ? { transport: generated.toolCall ? 'TOOL_CALL' : 'TEXT' } : { transport: 'TEXT' as const }) };
    } catch (error) {
      const base: ReviewCall = { status: 'FAIL', error: { code: error instanceof Error ? error.name : 'REVIEW_CALL_FAILED' } };
      return error instanceof NightshiftChatError ? { ...base, ...(error.receipt ? { receipt: error.receipt } : {}), ...(error.responseText ? { responseText: error.responseText } : {}), ...(error.responseTruncated ? { truncated: true } : {}) } : base;
    }
  }
}
