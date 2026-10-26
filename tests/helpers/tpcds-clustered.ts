import { agentFixtures } from '../../src/eval/agent-eval.ts';
import type { FixtureTable } from '../../src/eval/fixture-client.ts';
import { zetarisTableSpecs } from '../../src/relations/adapters/zetaris.ts';
import { executeProbe, distinctKeysScope, withDistinctKeysSource } from '../../src/relations/probes.ts';
import { legacyRelationContract, planLegacyProbe } from '../../src/relations/legacy.ts';
import { ZetarisProbeAdapter } from '../../src/relations/adapters/zetaris.ts';
import { evaluateRelation } from '../../src/relations/decision.ts';
import { relationPolicyFromConfig } from '../../src/relations/policy.ts';
import { universeConfig } from '../../src/universe-pipeline.ts';
import { readJson } from '../../src/runtime.ts';
import type { EvidenceBundle } from '../../src/contracts/types.ts';

/**
 * The offline TPC-DS fixture with the M12 shape: tables stored in key order, so the first rows of the fact tables carry ONE value of the key column
 * (inventory.inv_warehouse_sk, inventory.inv_date_sk, catalog_page.cp_end_date_sk), while later rows carry five. The dimensions are the fixture's own.
 */
export function clusteredTpcdsTables(): Record<string, FixtureTable> {
  const tables = structuredClone(agentFixtures().find(item => item.alias === 'TPCDS')!.tables) as Record<string, FixtureTable>;
  tables.inventory.rows = Array.from({ length: 40 }, (_, i) => i < 25 ? [2450001, 300 + i, 1] : [2450001 + (i % 5), 300 + i, 1 + (i % 5)]);
  tables.catalog_page.rows = Array.from({ length: 30 }, (_, i) => [i + 1, `CA${String(i + 1).padStart(4, '0')}`, `Page ${i + 1}`, 2450001, i < 22 ? 2450001 : 2450002 + (i % 4)]);
  return tables;
}

/** The three relations the F-04 review deferred as M12, in the reviewed-FK form the policy accepts (inverted ones are not needed: the source is the fact side). */
export const M12_RELATIONS = [
  { id: 'inventory.inv_warehouse_sk__warehouse.w_warehouse_sk', from: ['inventory', 'inv_warehouse_sk'], to: ['warehouse', 'w_warehouse_sk'] },
  { id: 'inventory.inv_date_sk__date_dim.d_date_sk', from: ['inventory', 'inv_date_sk'], to: ['date_dim', 'd_date_sk'] },
  { id: 'catalog_page.cp_end_date_sk__date_dim.d_date_sk', from: ['catalog_page', 'cp_end_date_sk'], to: ['date_dim', 'd_date_sk'] }
].map(item => ({ id: item.id, from: { db: 'TPCDS_DB', table: item.from[0], column: item.from[1] }, to: { db: 'TPCDS_DB', table: item.to[0], column: item.to[1] },
  kind: 'FOREIGN_KEY' as const, identifierSpace: 'sk', normalizationVersion: '1', normalizationLossless: true, normalizationAdapterCapability: 'integer', reviewState: 'REVIEWED' as const }));

/** The pipeline's own steps for one relation (plan -> distinct-keys probe -> common decision), with the seeds the caller chooses. */
export async function probeWithSeeds(client: any, relation: (typeof M12_RELATIONS)[number], seeds: (string | number)[], augment?: (bundle: EvidenceBundle) => void) {
  const cfg = universeConfig('TPCDS'), specs = zetarisTableSpecs(cfg);
  const allowlist = Object.fromEntries(Object.entries<any>(cfg.tables).map(([table, spec]) => [`${spec.db}.${table}`, spec.columns.map((column: any) => column.name)]));
  const filters = Object.fromEntries([relation.from, relation.to].map(endpoint => [`${endpoint.db}.${endpoint.table}`, { column: endpoint.column, values: seeds }]));
  const base = planLegacyProbe(relation, 'TPCDS', '1.0', 'integer', 3, allowlist, 50, {}, filters);
  const execution = await executeProbe(withDistinctKeysSource(base), new ZetarisProbeAdapter(specs, client), { runId: `r:${relation.id}`, checkedAt: '2026-10-25T00:00:00.000Z', scope: distinctKeysScope(seeds.length) });
  augment?.(execution.bundle);
  const contract = legacyRelationContract(relation, 'TPCDS', '1.0', 'integer', 3);
  return { execution, contract, decision: evaluateRelation(contract, [execution.bundle], relationPolicyFromConfig(readJson('config/thresholds.json'))) };
}

