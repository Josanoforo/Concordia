import test from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_COLUMN, KEY_COLUMN, validateExplorationCatalog } from '../src/agent/catalog.ts';
import { compileReadSql } from '../src/agent/exploration.ts';
import { loadTpcdsGold } from '../src/eval/tpcds-gold.ts';

test('P4: key columns (*_sk, *_id) are not forbidden even when they carry a content word; content columns stay forbidden', () => {
  for (const key of ['ca_address_sk', 'c_current_addr_sk', 'ss_item_sk', 'c_customer_id', 'ca_address_id', 'cc_state_sk', 'contact_id'])
    assert.equal(FORBIDDEN_COLUMN.test(key), false, key);
  for (const content of ['ca_street_name', 'ca_street_number', 'c_email_address', 'ca_phone', 'cc_city', 'ca_city', 'ca_zip', 'ca_state', 'officer_name', 'contact_email', 'ca_address_line', 'postal_code', 'cust_phone_number'])
    assert.equal(FORBIDDEN_COLUMN.test(content), true, content);
  assert.equal(KEY_COLUMN.test('ca_address_sk'), true); assert.equal(KEY_COLUMN.test('ca_street_name'), false);
});

test('P4: a name the caller declares as a key column is exempt too, only when declared', () => {
  assert.equal(FORBIDDEN_COLUMN.test('postal_code'), true);
  assert.equal(FORBIDDEN_COLUMN.test('postal_code', new Set(['postal_code'])), false);
  assert.equal(FORBIDDEN_COLUMN.test('email_address', new Set(['postal_code'])), true);
});

test('P4: with the filter lifted for keys, ca_address_sk is in COMA scope and a read of it never projects a content column', () => {
  const cfg: any = { tables: { customer_address: { db: 'TPCDS_DB', physicalTable: 'customer_address', columns: [{ name: 'ca_address_sk' }, { name: 'ca_street_name' }, { name: 'ca_city' }, { name: 'ca_zip' }] } } };
  const catalog: any = { productLabel: 'T', plannerTask: 'x', observations: { K: { fromTable: 'customer_address', column: 'ca_address_sk', pattern: '^[0-9]+$' } }, actions: [] };
  const described = new Set(['ca_address_sk', 'ca_street_name', 'ca_city', 'ca_zip']);
  for (const kind of ['KEYED_READ', 'COMPARE_KEYS', 'AGGREGATE_COUNT'] as const) {
    const action: any = { id: 'READ_CA', kind, table: 'customer_address', filterColumn: 'ca_address_sk', observation: 'K' };
    const read = compileReadSql(action, cfg, catalog, described, ['1', '2'], 10);
    assert.deepEqual(read.columns.filter(column => /street|city|zip/.test(column)), [], `${kind} projects no content column`);
    assert.doesNotMatch(read.sql, /ca_street_name|ca_city|ca_zip/, kind);
    assert.match(read.sql, /ca_address_sk/);
  }
  // A content column is still refused as a filter column by the executor and by the catalog validator.
  const bad: any = { id: 'READ_CITY', kind: 'COMPARE_KEYS', table: 'customer_address', filterColumn: 'ca_city', observation: 'K' };
  assert.throws(() => compileReadSql(bad, cfg, catalog, described, ['x'], 10), /AGENT_REQUIRED_COLUMN_UNAVAILABLE/);
  const issues = validateExplorationCatalog({ ...cfg, explorationCatalog: { ...catalog, actions: [bad] } }, 'u').map(issue => issue.code);
  assert.ok(issues.includes('FORBIDDEN_OR_INVALID_COLUMN'));
});

test('P4: the 11 gold foreign keys that ended in ca_address_sk are no longer hidden by the name filter', () => {
  const gold = loadTpcdsGold(), hidden = gold.edges.filter(edge => FORBIDDEN_COLUMN.test(edge.from.column) || FORBIDDEN_COLUMN.test(edge.to.column));
  assert.equal(hidden.length, 0);
  assert.equal(gold.edges.length, 103, 'the recall denominator is the whole gold again');
});
