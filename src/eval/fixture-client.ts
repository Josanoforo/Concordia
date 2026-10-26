import { assertRunSqlAllowed } from '../clients/zetaris.ts';
/**
 * Offline stand-in for the Zetaris client driven by a declarative fixture: table rows keyed by the universe's table ids.
 * It understands exactly the bounded SELECT shapes the agent, probes and critic emit (projection, IN / NOT IN filter, LIMIT).
 */
export interface FixtureTable { columns: { name: string; type: string }[]; rows: unknown[][] }
export interface AgentFixture { alias: string; basis: string; /** COMA answers the fixture scripts for a blind universe (stand-in identity); absent means the name-token stand-in answers. */ comaProposals?: { source: string; target: string; sourceColumn: string; targetColumn: string; rawScore: number }[]; chooserScript: string[]; tables: Record<string, FixtureTable>; adjudications: Record<string, 'APPROVABLE' | 'NONAPPROVABLE' | 'UNKNOWN'> }

export function fixtureClient(cfg: any, tables: Record<string, FixtureTable>, log: string[] = []) {
  const byPhysical = Object.entries<any>(cfg.tables).map(([id, spec]) => ({ id, pattern: new RegExp('\\b' + spec.physicalTable + '\\b'), spec }));
  const find = (sql: string) => byPhysical.find(item => item.pattern.test(sql));
  let counter = 0;
  return {
    async describe(_db: string, physicalTable: string) {
      const hit = byPhysical.find(item => item.spec.physicalTable === physicalTable);
      if (!hit || !tables[hit.id]) throw new Error('FIXTURE_TABLE_UNKNOWN');
      return { rows: tables[hit.id].columns.map(column => [column.name, column.type]), requestId: `fixture-describe-${hit.id}`, queryId: `fixture-describe-${hit.id}`, sql: 'DESCRIBE', durationMs: 0, utc: '2026-10-24T00:00:00.000Z' };
    },
    async runSql(sql: string, limit = 20) {
      // The SAME gate as the real read client (Zetaris.runSql): what live refuses (FORBIDDEN_SQL, READ_PATH_MUTATION_FORBIDDEN) is refused here before any answer.
      assertRunSqlAllowed(sql);
      log.push(sql);
      const hit = find(sql);
      if (!hit || !tables[hit.id]) throw new Error('FIXTURE_TABLE_UNKNOWN');
      const table = tables[hit.id], names = table.columns.map(column => column.name);
      // BOUNDED_PROFILE: rows, distinct values and nulls of one key column over at most LIMIT rows.
      const profile = /^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT (\w+)\) AS concordia_distinct, .* FROM \(SELECT `?\w+`? FROM [\w.`]+ LIMIT (\d+)\) concordia_bounded$/i.exec(sql);
      if (profile) {
        const index = names.indexOf(profile[1]), sample = table.rows.slice(0, Number(profile[2])).map(row => row[index]);
        counter++;
        return { sql, requestId: `fixture-req-${counter}`, queryId: `fixture-q-${counter}`, durationMs: 0, utc: '2026-10-24T00:00:00.000Z', rows: [[sample.length, new Set(sample.filter(value => value !== null && value !== undefined)).size, sample.filter(value => value === null || value === undefined).length]] };
      }
      const distinct = /^SELECT\s+DISTINCT\s/i.test(sql);
      const projection = /^SELECT (?:DISTINCT\s+)?(.+?) FROM /is.exec(sql)![1].split(',').map(item => item.trim().replace(/`/g, ''));
      let rows = table.rows;
      const values = (text: string) => [...text.matchAll(/'((?:[^']|'')*)'/g)].map(item => item[1].replace(/''/g, "'"));
      const include = /`?(\w+)`?\s+IN\s+\(([^)]*)\)/i.exec(sql.replace(/NOT IN/gi, 'NOTIN'));
      if (include) { const index = names.indexOf(include[1]), wanted = values(include[2]); rows = rows.filter(row => wanted.includes(String(row[index]))); }
      const exclude = /`?(\w+)`?\s+NOT IN\s+\(([^)]*)\)/i.exec(sql);
      if (exclude) { const index = names.indexOf(exclude[1]), unwanted = values(exclude[2]); rows = rows.filter(row => !unwanted.includes(String(row[index]))); }
      counter++;
      return { sql, requestId: `fixture-req-${counter}`, queryId: `fixture-q-${counter}`, durationMs: 0, utc: '2026-10-24T00:00:00.000Z',
        rows: (distinct ? [...new Map(rows.map(row => [JSON.stringify(projection.map(column => row[names.indexOf(column)] ?? null)), row])).values()] : rows).slice(0, limit).map(row => projection.map(column => row[names.indexOf(column)] ?? null)) };
    }
  };
}

/** R-03: the offline fixture of a local-files universe is its own config rows; nothing is read from outside the config. */
export function fixtureTablesFromConfig(cfg: any): Record<string, FixtureTable> {
  return Object.fromEntries(Object.entries<any>(cfg.tables ?? {}).map(([id, table]) => [id, { columns: table.columns.map((column: any) => ({ name: column.name, type: column.type ?? 'string' })), rows: table.fixtureRows ?? [] }]));
}
