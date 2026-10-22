import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalKey, projection, quotedValues, universe } from '../src/universe.ts';
test('allowlist rejects sensitive projections and excludes five operational tables', () => {
  assert.equal(Object.keys(universe().tables).length, 10);
  for (const column of ['the_geom','latitude','longitude','driver_id','customer_id','pickup_address']) assert.throws(() => projection('trips', [column]));
  assert.throws(() => projection('drivers', ['driver_id']));
  assert.equal(projection('taxi_zones', ['LocationID','zone']), 'LocationID, zone');
});
test('key comparison handles textual .0 without truncating genuine decimals; quotes are escaped', () => {
  assert.equal(canonicalKey('001.00'), '1'); assert.equal(canonicalKey('1.25'), '1.25'); assert.equal(canonicalKey(null), null);
  assert.equal(quotedValues(["a'b"]), "'a''b'");
});
