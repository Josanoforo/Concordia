import { Nightshift } from './clients/nightshift.ts';
import { Zetaris } from './clients/zetaris.ts';
import fs from 'node:fs';
import path from 'node:path';
import { failure, readJson, ROOT, SafeError, stamp, writeJson } from './runtime.ts';
import { budgetFilePath, readBudget } from './budget.ts';

export async function connection(smoke: boolean) {
  const evidence: any = { utc: new Date().toISOString(), live: true, steps: [], generations: 0 };
  const consumed = () => fs.existsSync(budgetFilePath()) ? readBudget().consumed : 0;
  const consumedBefore = consumed();
  let blocked = false;
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { const result = await fn(); evidence.steps.push({ name, status: 'PASS', result }); console.log('PASS', name); return result; }
    catch (error) { evidence.steps.push({ name, status: 'FAIL', ...failure(error) }); console.log('FAIL', name, failure(error).code); blocked = true; return undefined; }
  };
  const z = new Zetaris(); const n = new Nightshift();
  await step('Zetaris autorizado y bases descubiertas', async () => {
    const result = await z.listDatabases();
    const names = result.rows.map(r => String(r[0]));
    if (!['NY_TAXI', 'TPCDS_DB'].every(db => names.includes(db))) throw new SafeError('EXPECTED_DATABASES_MISSING');
    return { requestId: result.requestId, names };
  });
  const models = await step('Nightshift autorizado y catálogo', () => n.models()) as string[] | undefined;
  if (models) await step('Nightshift texto real y recibo vía meterless/cheap', async () => {
    if (!models.includes('meterless/cheap')) throw new SafeError('CHEAP_ROUTE_NOT_DISCOVERED');
    const result = await n.chat([{ role: 'user', content: 'Reply with exactly CONCORDIA_OK.' }], { maxTokens: 48, route: 'meterless/cheap' });
    if (result.receipt.provider !== 'anthropic') throw new SafeError('ANTHROPIC_NOT_CONFIRMED');
    evidence.buildRoute = 'meterless/cheap'; // chat enforces Anthropic Haiku.
    return result;
  });
  evidence.status = blocked ? 'FAIL' : 'PASS';
  evidence.generations = consumed() - consumedBefore;
  if (!smoke) {
    const state = fs.existsSync(budgetFilePath()) ? readBudget() : null;
    const latest = state?.attempts?.at(-1);
    writeJson(`evidence/route-check-${stamp()}.json`, { utc: new Date().toISOString(), status: evidence.status,
      generationsAdded: evidence.generations, consumed: state?.consumed, receipt: latest?.receipt,
      text: evidence.steps.find((s: any) => s.result?.text)?.result?.text, error: latest?.error,
      requestedRoute: 'meterless/cheap', steps: evidence.steps });
  }
  const file = `evidence/${smoke ? 'smoke' : 'connection'}-${stamp()}.json`;
  writeJson(file, evidence);
  console.log('Evidencia:', file);
  if (blocked) throw new SafeError('CONNECTION_CHECK_FAILED');
  return evidence;
}
