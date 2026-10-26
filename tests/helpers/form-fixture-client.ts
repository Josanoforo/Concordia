import { assertRunSqlAllowed } from '../../src/clients/zetaris.ts';
import { fixtureClient, type FixtureTable } from '../../src/eval/fixture-client.ts';

/**
 * Offline stand-in for the Zetaris client that also answers the Round 9 closed forms (F1 global profile, F2 duplicated keys, F3a/F3b anti-join, F4 distinct keys) and the Round 10 ones (F1x extended profile, F3c orphans by rows)
 * over declarative fixture tables. Every statement goes through the REAL read guard first, so a form the guard refuses is refused here too. Anything that is not one
 * of the forms is delegated to the shared fixture client (probe reads, bounded profiles, keyed reads).
 */
const SRC = String.raw`(?:\(SELECT [\w, ]+ FROM (\w+)\.(\w+)\) concordia_source|(\w+)\.(\w+))`;
const F1 = new RegExp(String.raw`^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT (\w+)\) AS concordia_distinct, SUM\(CASE WHEN \w+ IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls FROM ${SRC}$`);
/** The same source carrying the alias concordia_s itself (F3c). */
const SRCS = String.raw`(?:\(SELECT [\w, ]+ FROM (\w+)\.(\w+)\) concordia_s|(\w+)\.(\w+) concordia_s)`;
const F1X = new RegExp(String.raw`^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT (\w+)\) AS concordia_distinct, SUM\(CASE WHEN \w+ IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls, MIN\(\w+\) AS concordia_min, MAX\(\w+\) AS concordia_max, AVG\(LENGTH\(CAST\(\w+ AS STRING\)\)\) AS concordia_avg_len FROM ${SRC}$`);
const F3C = new RegExp(String.raw`^SELECT COUNT\(\*\) AS concordia_missing_rows FROM ${SRCS} LEFT JOIN \(SELECT DISTINCT (\w+) AS k FROM ${SRC}\) concordia_t ON concordia_s\.(\w+) = concordia_t\.k WHERE concordia_s\.\w+ IS NOT NULL AND concordia_t\.k IS NULL$`);
const F2 = new RegExp(String.raw`^SELECT (\w+), COUNT\(\*\) AS concordia_count FROM ${SRC} GROUP BY \w+ HAVING COUNT\(\*\) > 1 LIMIT (\d+)$`);
const F3 = new RegExp(String.raw`^SELECT (concordia_s\.k|COUNT\(\*\) AS concordia_missing) FROM \(SELECT DISTINCT (\w+) AS k FROM ${SRC} WHERE \w+ IS NOT NULL\) concordia_s LEFT JOIN \(SELECT DISTINCT (\w+) AS k FROM ${SRC}\) concordia_t ON concordia_s\.k = concordia_t\.k WHERE concordia_t\.k IS NULL(?: LIMIT (\d+))?$`);

export interface FormFixtureLog { sqls: string[] }
export function formFixtureClient(cfg: any, tables: Record<string, FixtureTable>, log: string[] = []) {
  const base = fixtureClient(cfg, tables, log);
  const idOf = (physical: string) => { const hit = Object.entries<any>(cfg.tables).find(([, spec]) => spec.physicalTable === physical); if (!hit || !tables[hit[0]]) throw new Error('FIXTURE_TABLE_UNKNOWN'); return hit[0]; };
  const column = (table: FixtureTable, name: string) => { const index = table.columns.findIndex(item => item.name === name); if (index < 0) throw new Error('FIXTURE_COLUMN_UNKNOWN'); return table.rows.map(row => row[index]); };
  let counter = 0;
  const answer = (sql: string, rows: unknown[][]) => { counter++; return { sql, requestId: `form-req-${counter}`, queryId: `form-q-${counter}`, durationMs: 0, utc: '2026-10-25T00:00:00.000Z', rows }; };
  return {
    describe: base.describe,
    async runSql(sql: string, limit = 20, _options?: unknown) {
      assertRunSqlAllowed(sql);
      const f1 = F1.exec(sql);
      if (f1) {
        const values = column(tables[idOf(f1[3] ?? f1[5])], f1[1]); log.push(sql);
        return answer(sql, [[values.length, new Set(values.filter(value => value !== null && value !== undefined).map(String)).size, values.filter(value => value === null || value === undefined).length]]);
      }
      const f1x = F1X.exec(sql);
      if (f1x) {
        const values = column(tables[idOf(f1x[3] ?? f1x[5])], f1x[1]), present = values.filter(value => value !== null && value !== undefined); log.push(sql);
        const ordered = [...present].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
        return answer(sql, [[values.length, new Set(present.map(String)).size, values.length - present.length, ordered[0] ?? null, ordered.at(-1) ?? null, present.length ? present.reduce((sum: number, value) => sum + String(value).length, 0) / present.length : null]]);
      }
      const f3c = F3C.exec(sql);
      if (f3c) {
        // LEFT JOIN semantics: a NULL key never matches (neither side), a NULL source key is filtered out, a NULL in the target removes nothing.
        const target = new Set(column(tables[idOf(f3c[7] ?? f3c[9])], f3c[5]).filter(value => value !== null && value !== undefined).map(String)); log.push(sql);
        const source = column(tables[idOf(f3c[2] ?? f3c[4])], f3c[10]).filter(value => value !== null && value !== undefined);
        return answer(sql, [[source.filter(value => !target.has(String(value))).length]]);
      }
      const f2 = F2.exec(sql);
      if (f2) {
        const counts = new Map<string, number>(); for (const value of column(tables[idOf(f2[3] ?? f2[5])], f2[1])) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1); log.push(sql);
        return answer(sql, [...counts].filter(([, count]) => count > 1).slice(0, Number(f2[6])).map(([key, count]) => [key, count]));
      }
      const f3 = F3.exec(sql);
      if (f3) {
        const source = new Set(column(tables[idOf(f3[4] ?? f3[6])], f3[2]).filter(value => value !== null && value !== undefined).map(String));
        const target = new Set(column(tables[idOf(f3[9] ?? f3[11])], f3[7]).filter(value => value !== null && value !== undefined).map(String)); log.push(sql);
        const missing = [...source].filter(key => !target.has(key));
        return answer(sql, f3[1].startsWith('COUNT') ? [[missing.length]] : missing.slice(0, Number(f3[12])).map(key => [key]));
      }
      return base.runSql(sql, limit);
    }
  };
}
