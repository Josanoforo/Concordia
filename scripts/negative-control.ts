// Act 3 negative control: probes the decoys (relations that are NOT in the approved contracts) through the distinct-keys path and writes negative-control.json.
// Read only, at most 2 SQL per decoy (6 in total), no memory, no decisions. The live run is launched only with the human's approval; --offline uses the fixture.
// Usage: node scripts/run-tsx.mjs scripts/negative-control.ts --run <sourceRunWithDiscovery> --out-run <runId> [--offline]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, SafeError } from '../src/runtime.ts';
import { checkDistinctKeys } from './check-distinct-keys.ts';

export const NEGATIVE_CONTROL_DECOYS = [
  { from: 'store_sales.ss_store_sk', to: 'web_site.web_site_sk' },
  { from: 'inventory.inv_warehouse_sk', to: 'ship_mode.sm_ship_mode_sk' },
  { from: 'store_sales.ss_promo_sk', to: 'reason.r_reason_sk' }
];
export type DecoyOutcome = 'REJECTED_BY_EVIDENCE' | 'OUT_OF_CONTRACT_ONLY';

/** A decoy the policy alone would sustain is protected only by not being in the human contract set; any other verdict is a rejection by the evidence itself. */
export const classifyDecoy = (verdict: string): DecoyOutcome => verdict === 'SOSTENIDA' ? 'OUT_OF_CONTRACT_ONLY' : 'REJECTED_BY_EVIDENCE';

export async function runNegativeControl(o: { universe?: string; sourceRun?: string; outRun: string; offline?: boolean; dir?: string; client?: any; inventory?: any; loadEnv?: () => void; contractIds?: readonly string[] }) {
  const universe = o.universe ?? 'TPCDS', decoys: any[] = [];
  let sqlSent = 0;
  for (const decoy of NEGATIVE_CONTROL_DECOYS) {
    const lines: any[] = [];
    const { sent } = await checkDistinctKeys({ universe, from: decoy.from, to: decoy.to, run: o.sourceRun, offline: o.offline, client: o.client, inventory: o.inventory, loadEnv: o.loadEnv }, line => lines.push(line));
    sqlSent += sent;
    const verdict = lines.at(-1);
    const id = `${decoy.from}__${decoy.to}`;
    decoys.push({ id, from: decoy.from, to: decoy.to, inContract: (o.contractIds ?? []).includes(id), sql: lines.filter(line => line.side).map(line => ({ side: line.side, sql: line.sql, rows: line.rows, distinctKeys: line.distinctKeys, truncated: line.truncated })),
      hypotheticalVerdict: verdict.verdict, reasonCodes: verdict.reasonCodes, outcome: classifyDecoy(verdict.verdict) });
  }
  if (sqlSent > 6) throw new SafeError('NEGATIVE_CONTROL_SQL_CAP_EXCEEDED');
  const artifact = { schemaVersion: 1, kind: 'ACT3_NEGATIVE_CONTROL', label: o.offline ? 'OFFLINE_FIXTURE' : 'LIVE_READ_ONLY', universe, sourceRun: o.sourceRun ?? null, runId: o.outRun, sqlSent, sqlCeiling: 6,
    contract: 'SYNTHETIC REVIEWED contract per decoy, hypothetical; not a human review and not part of the approved set',
    note: 'OUT_OF_CONTRACT_ONLY: the policy alone would sustain the decoy (key membership); only the human contract set keeps it out. REJECTED_BY_EVIDENCE: the evidence itself rejects it.',
    decoys, outOfContractOnly: decoys.filter(item => item.outcome === 'OUT_OF_CONTRACT_ONLY').map(item => item.id), rejectedByEvidence: decoys.filter(item => item.outcome === 'REJECTED_BY_EVIDENCE').map(item => item.id) };
  const dir = o.dir ?? path.join(ROOT, '.concordia', 'agent-runs', o.outRun);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'negative-control.json'), JSON.stringify(artifact, null, 2) + '\n');
  return artifact;
}

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outRun = arg('out-run');
  if (!outRun || !/^[A-Za-z0-9._-]{1,80}$/.test(outRun)) { console.error('usage: --run <sourceRun> --out-run <runId> [--offline]'); process.exit(2); }
  runNegativeControl({ sourceRun: arg('run'), outRun, offline: process.argv.includes('--offline') }).then(a => console.log(JSON.stringify({ written: `.concordia/agent-runs/${outRun}/negative-control.json`, label: a.label, outOfContractOnly: a.outOfContractOnly, rejectedByEvidence: a.rejectedByEvidence }))).catch(e => { console.error(JSON.stringify({ error: e?.code ?? e?.message ?? String(e) })); process.exit(1); });
}
