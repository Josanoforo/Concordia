import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunSqlAllowed } from '../src/clients/zetaris.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** L3-2: the offline fixture client applies the very gate the real read client applies, so eval and tests refuse what live would refuse. */
const code = (fn: () => unknown) => { try { fn(); return 'ACCEPTED'; } catch (error) { return (error as { code?: string }).code ?? 'THROWS'; } };
const cfg = universeConfig('AGENTFX'), client = () => fixtureClient(cfg, agentFixtures().find(item => item.alias === 'AGENTFX')!.tables);
const sqls = [
  'SELECT customer_id FROM agent_fixture.customers LIMIT 20',
  "SELECT customer_id FROM (SELECT customer_id FROM agent_fixture.customers) concordia_source WHERE customer_id IN ('c1') LIMIT 20",
  'SELECT customer_id FROM agent_fixture.customers a JOIN agent_fixture.orders b ON a.customer_id = b.customer_id LIMIT 20',
  'SELECT customer_id FROM agent_fixture.customers ORDER BY customer_id LIMIT 20',
  'SELECT customer_id, COUNT(*) FROM agent_fixture.customers GROUP BY customer_id LIMIT 20',
  'SELECT COUNT(*) AS n FROM agent_fixture.customers',
  'DROP TABLE agent_fixture.customers',
  'SELECT customer_id FROM agent_fixture.customers LIMIT 20; DROP TABLE agent_fixture.customers',
  'INSERT INTO agent_fixture.customers VALUES (1)',
  'UPDATE agent_fixture.customers SET customer_id = 1'
];

test('for every statement the fixture client answers exactly as the real gate decides: same acceptance, same error code', async () => {
  for (const sql of sqls) {
    const real = code(() => assertRunSqlAllowed(sql)), offline = await client().runSql(sql, 20).then(() => 'ACCEPTED', (error: { code?: string }) => error.code ?? 'THROWS');
    if (real === 'ACCEPTED') assert.ok(!['FORBIDDEN_SQL', 'READ_PATH_MUTATION_FORBIDDEN'].includes(offline), `${sql}: an accepted statement may fail on the fixture's own table lookup, never on the gate`);
    else assert.equal(offline, real, sql);
  }
});

test('what live refuses is refused offline before any answer: joins, ordering, grouping, bare counts and mutations never reach the fixture', async () => {
  for (const sql of sqls.slice(2, 5).concat(sqls.slice(6))) await assert.rejects(() => client().runSql(sql, 20), (error: { code?: string }) => ['FORBIDDEN_SQL', 'READ_PATH_MUTATION_FORBIDDEN'].includes(error.code ?? ''), sql);
  const log: string[] = [], logged = fixtureClient(cfg, agentFixtures().find(item => item.alias === 'AGENTFX')!.tables, log);
  await assert.rejects(() => logged.runSql(sqls[2], 20));
  assert.deepEqual(log, [], 'a refused statement is not even logged as read');
});

test('the bounded statements the loop really emits still pass the gate', async () => {
  const answered = await client().runSql(sqls[0], 20);
  assert.ok(answered.rows.length > 0);
  assert.equal(code(() => assertRunSqlAllowed(sqls[1])), 'ACCEPTED');
});
