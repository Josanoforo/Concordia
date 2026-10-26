// M7-3 live smoke (read only): runs ONE hypothetical relation through the exact probeUniverse path in distinct-keys mode and prints one JSON line per side plus the policy's diagnostic.
// The contract is SYNTHETIC and labelled HYPOTHETICAL: it is not a human review. At most 2 SQL statements; no memory, no decisions, nothing persisted.
// Usage: node scripts/run-tsx.mjs scripts/check-distinct-keys.ts --universe TPCDS --from store_sales.ss_store_sk --to store.s_store_sk [--run agent-tpcds-live-03] [--offline]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SafeError, loadLocalEnv, readJson } from '../src/runtime.ts';
import { probeUniverse, universeConfig } from '../src/universe-pipeline.ts';
import { Zetaris } from '../src/clients/zetaris.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';

export const MAX_SQL = 2;
const endpointOf = (text: string, cfg: any) => {
  const [table, column] = text.split('.');
  if (!table || !column || !cfg.tables[table]?.columns?.some((item: any) => item.name === column)) throw new SafeError('CHECK_ENDPOINT_OUTSIDE_ALLOWLIST', undefined, text);
  return { db: cfg.tables[table].db ?? cfg.database, table, column };
};
const inventoryFromFixture = (cfg: any, fixture: any) => ({ tables: Object.fromEntries(Object.entries<any>(fixture.tables).map(([name, t]) => [name, { columns: t.columns.map((c: any) => c.name), schema: t.columns, sample: { rows: t.rows.slice(0, cfg.sampleLimit ?? 20) }, labels: cfg.tables[name]?.labels ?? [], keyColumns: cfg.tables[name]?.keyColumns ?? [], role: cfg.tables[name]?.role ?? 'dimension' }])) });

export async function checkDistinctKeys(o: { universe: string; from: string; to: string; run?: string; offline?: boolean; client?: any; inventory?: any; /** Loads the local Zetaris config (values never printed). Live only; defaults to the CLI's loadLocalEnv. */ loadEnv?: () => void }, print: (line: unknown) => void = line => console.log(JSON.stringify(line))) {
  if (!o.offline && !o.client) (o.loadEnv ?? loadLocalEnv)();
  const cfg = universeConfig(o.universe), mode = cfg.normalizationContract?.defaultMode ?? 'text';
  const from = endpointOf(o.from, cfg), to = endpointOf(o.to, cfg);
  const fixture = o.offline ? agentFixtures().find(item => item.alias === o.universe) : undefined;
  if (o.offline && !fixture) throw new SafeError('CHECK_OFFLINE_FIXTURE_MISSING');
  const inventory = o.inventory ?? (o.run ? readJson(`.concordia/agent-runs/${o.run}/discovery.json`) : fixture && !o.run ? inventoryFromFixture(cfg, fixture) : readJson(`out/${o.universe}/discovery.json`));
  // The offline fixture client has no DISTINCT: the stand-in answers the same statement without it and de-duplicates, which is what DISTINCT returns.
  const offlineClient = () => { const inner: any = fixtureClient(cfg, fixture!.tables as any); return { runSql: async (sql: string, limit?: number) => {
    if (!/^SELECT DISTINCT /i.test(sql)) return inner.runSql(sql, limit);
    const cap = Number(/LIMIT (\d+)\s*$/i.exec(sql)?.[1] ?? limit ?? 50), result = await inner.runSql(sql.replace(/^SELECT DISTINCT /i, 'SELECT ').replace(/LIMIT \d+\s*$/i, 'LIMIT 100000'), 100000);
    return { ...result, sql, rows: [...new Map(result.rows.map((row: unknown[]) => [JSON.stringify(row), row])).values()].slice(0, cap) };
  } }; };
  const base = o.client ?? (fixture ? offlineClient() : new Zetaris());
  let sent = 0;
  const client: any = { runSql: async (sql: string, ...rest: any[]) => { if (++sent > MAX_SQL) throw new SafeError('CHECK_SQL_CAP_EXCEEDED'); return base.runSql(sql, ...rest); } };
  // Synthetic REVIEWED contract so the policy can answer; it exists only inside this call.
  const relation = { id: `${o.from}__${o.to}`, from, to, kind: 'FOREIGN_KEY', identifierSpace: 'HYPOTHETICAL', normalization: mode, normalizationVersion: '1', normalizationLossless: true, normalizationAdapterCapability: mode, reviewState: 'REVIEWED' };
  const result = await probeUniverse(o.universe, { inventory, client, persist: false, recordFreshness: false, probeMode: 'distinct-keys', dispersedSeeds: false, relations: [relation], executionMode: o.offline ? 'LOCAL' : 'LIVE', dataOrigin: o.offline ? 'SYNTHETIC' : undefined } as any);
  const evidence = result.relations[0].evidence;
  evidence.typedEvidence.observations.filter((obs: any) => obs.type === 'KEY_MEMBERSHIP').forEach((obs: any, index: number) => {
    const query = evidence.queries[index];
    print({ side: index === 0 ? 'SOURCE' : 'TARGET', ...(o.offline && index === 0 ? { standIn: 'DISTINCT_EMULATED_BY_OFFLINE_FIXTURE' } : {}), sql: query?.sql ?? null, rows: obs.measuredTuples.length, distinctKeys: new Set(obs.measuredTuples.map((t: unknown[]) => String(t[0]))).size, truncated: obs.truncated, transportStatus: obs.transportStatus });
  });
  const decision = evidence.decision;
  print({ hypotheticalContract: true, notAHumanReview: true, verdict: decision.verdict, reasonCodes: decision.reasonCodes, requirementsMissing: decision.requirementsMissing, scope: evidence.typedEvidence.scope?.value, multiplicity: { source: evidence.multiplicity.sourceMultiplicity ?? 'MEASURED_IN_READ', manyToManyKeys: evidence.multiplicity.manyToManyKeys.length, targetDuplicateKeys: evidence.multiplicity.to.duplicateKeys.length }, sqlSent: sent, mode: o.offline ? 'OFFLINE_FIXTURE' : 'LIVE_READ_ONLY' });
  return { sent, decision };
}

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const universe = arg('universe'), from = arg('from'), to = arg('to');
  if (!universe || !from || !to) { console.error('usage: --universe <id> --from table.column --to table.column [--run <runId>] [--offline]'); process.exit(2); }
  checkDistinctKeys({ universe, from, to, run: arg('run'), offline: process.argv.includes('--offline') }).catch(error => { console.error(JSON.stringify({ error: error?.code ?? error?.message ?? String(error) })); process.exit(1); });
}
