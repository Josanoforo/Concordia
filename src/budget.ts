import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SafeError } from './runtime.ts';

/** Resolve the append-only generation ledger without copying private state. */
export function budgetFilePath() {
  const configured = process.env.CONCORDIA_BUDGET_FILE;
  const file = configured ? path.resolve(configured) : path.join(ROOT, '.concordia/budget.json');
  if (configured && !fs.existsSync(file)) throw new SafeError('BUDGET_STATE_MISSING');
  return file;
}

export function readBudget() {
  const file = budgetFilePath();
  if (!fs.existsSync(file)) return { limit: null, consumed: 0, attempts: [] };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(state.consumed) || state.consumed < 0 || !Array.isArray(state.attempts) || state.consumed !== state.attempts.length) throw new SafeError('INVALID_BUDGET_STATE');
  return state;
}

export function writeBudget(state: unknown) {
  const file = budgetFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file);
}
