/**
 * U2 join-comparison policy still used by the U2 comparator. Budgets (steps, rows, queries, tokens) now come from the
 * manifest's AGENT_EXPLORATION bound via run-budget.ts, and safe optional columns from the universe's exploration catalog.
 */
import { FORBIDDEN_COLUMN } from './catalog.ts';

export const EXPLORATION_POLICY = {
  forbiddenColumn: FORBIDDEN_COLUMN,
  sampleMatchesPerAlternative: 5,
  /** Join alternatives are grouped by what they identify; the model picks one option per family or NO_JOIN. */
  joinFamilies: {
    identity: ['CIK_TEXT', 'CIK_NORMALIZED'],
    dns: ['SIC_CODE', 'SIC_DESCRIPTION', 'SIC_CODE_AND_DESCRIPTION']
  }
} as const;
