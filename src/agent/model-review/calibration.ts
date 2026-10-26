/**
 * C4 (Round 10 full TPCDS live run): what one review call really costs. The gate keeps its conservative upper bound (characters / 2 plus the whole output cap, run-budget.ts); these figures
 * are for planning and for valuing what the cascade saved, so the plan no longer rests on the 3.5k per call that the live run disproved.
 */
export const LIVE_CALL_CALIBRATION = {
  source: 'Round 10 full TPCDS live run 01 (agent-tpcds-r10-full-live-01), meterless/cheap',
  /** 355 calls, 1,592,366 tokens over the whole review: 4,486 per call. */
  totalTokensPerCall: 4486,
  /** First 242 calls: 986,768 input + 101,520 output tokens. The review is input-bound (91% input). */
  inputTokensPerCall: 4078,
  outputTokensPerCall: 419
} as const;

/** Rounded up from the observed 4,486; the figure a plan multiplies by a number of calls. */
export const PLANNING_TOKENS_PER_CALL = 4500;

/** Tokens a forced tool call adds to the input: probe 3a measured about 600 for a small function (621 input tokens for a one-line prompt). */
export const TOOL_CALL_SMALL_FUNCTION_TOKENS = 600;
