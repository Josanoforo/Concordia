import { Zetaris, type SqlResult } from '../clients/zetaris.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Candidate, Discovery, Endpoint, LiveTable } from '../discovery/index.ts';
import { failure, readJson, writeJson, ROOT } from '../runtime.ts';
import { normalizeKey, projection, quotedValues, type NormalizationMode } from '../universe.ts';
import { assessFreshness, assessPartialTransport } from './evidence-contract.ts';
import { classify } from './verdicts.ts';
export type Probe = {
  relation: Candidate; utc: string; status: string; queries: SqlResult[]; error?: object;
  overlap: { matched: number; probed: number; ratio: number | null; sampleKeys: string[] };
  multiplicity?: { from: RowMultiplicity; to: RowMultiplicity; sharedRowPairs: number; pairCounts: { key: string; fromRows: number; toRows: number; pairs: number }[]; manyToManyKeys: string[]; bounded: { from: boolean; to: boolean } };
  labelAgreement?: { agree: number; compared: number; ratio: number; examples: { key: string; fromLabel: string[]; toLabel: string[]; agrees: boolean }[] };
  typeCompat: { from: string; to: string; castable: boolean; normalization: string };
  nullRate: { from: number | null; to: number | null; denominatorFrom: number; denominatorTo: number };
  alerts: string[]; durationMs: number; freshness?: any;
};
export type RowMultiplicity = { rows: number; nonNullRows: number; nullRows: number; emptyRows: number; distinctKeys: number; duplicateKeys: { key: string; rows: number }[] };
function keyValues(t: LiveTable, e: Endpoint) { return t.sample.rows.map(row => row[t.columns.indexOf(e.column)]); }
export function measureMultiplicity(rows: any[][], columnIndex: number, mode: NormalizationMode): RowMultiplicity {
  const counts = new Map<string, number>(); let nullRows = 0, emptyRows = 0;
  for (const row of rows) {
    const raw = row[columnIndex];
    if (raw === null || raw === undefined) { nullRows++; continue; }
    if (String(raw) === '') { emptyRows++; continue; }
    const key = normalizeKey(raw, mode);
    if (key === null) { emptyRows++; continue; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateKeys = [...counts].filter(([, count]) => count > 1).map(([key, count]) => ({ key, rows: count }));
  return { rows: rows.length, nonNullRows: rows.length - nullRows - emptyRows, nullRows, emptyRows, distinctKeys: counts.size, duplicateKeys };
}
export function sharedRowPairs(leftRows: any[][], leftIndex: number, rightRows: any[][], rightIndex: number, mode: NormalizationMode) {
  const counts = (rows: any[][], index: number) => {
    const result = new Map<string, number>();
    for (const row of rows) { const key = normalizeKey(row[index], mode); if (key !== null) result.set(key, (result.get(key) ?? 0) + 1); }
    return result;
  };
  const left = counts(leftRows, leftIndex), right = counts(rightRows, rightIndex);
  const sharedKeys = [...left.keys()].filter(key => right.has(key));
  const pairCounts = sharedKeys.map(key => ({ key, fromRows: left.get(key)!, toRows: right.get(key)!, pairs: left.get(key)! * right.get(key)! }));
  return { sharedRowPairs: pairCounts.reduce((sum, item) => sum + item.pairs, 0), pairCounts,
    manyToManyKeys: sharedKeys.filter(key => left.get(key)! > 1 && right.get(key)! > 1) };
}
function nullRate(t: LiveTable, e: Endpoint, mode: NormalizationMode) {
  const values = keyValues(t, e); return values.length ? values.filter(v => normalizeKey(v, mode) === null).length / values.length : null;
}
function semanticAlerts(t: LiveTable): string[] {
  const index = t.columns.indexOf('passenger_count');
  if (index < 0) return [];
  const suspect = t.sample.rows.filter(r => Number(r[index]) > 8).length;
  // A conservative quality signal, not proof of an ingestion defect.
  return suspect ? [`PASSENGER_COUNT_GT_8_IN_${suspect}_OF_${t.sample.rows.length}_SAMPLED_ROWS_POSSIBLE_COLUMN_SHIFT`] : [];
}
export function compareLabels(fromRows: any[][], toRows: any[][], fromCols: string[], toCols: string[], from: Endpoint, to: Endpoint, fromLabels: string[], toLabels: string[], mode: NormalizationMode = 'integer') {
  if (!fromLabels.length || fromLabels.length !== toLabels.length) return undefined;
  const map = (rows: any[][], cols: string[], endpoint: Endpoint, labels: string[]) => {
    const result = new Map<string, (string | null)[][]>();
    for (const row of rows) {
      const key = normalizeKey(row[cols.indexOf(endpoint.column)], mode);
      if (key !== null) result.set(key, [...(result.get(key) ?? []), labels.map(l => {
        const value=row[cols.indexOf(l)]; if(value===null||value===undefined)return null;
        const text=String(value).trim(); return text===''?null:text;
      })]);
    }
    return result;
  };
  const a = map(fromRows, fromCols, from, fromLabels), b = map(toRows, toCols, to, toLabels);
  const examples = [...a].filter(([k]) => b.has(k)).flatMap(([key, fromVariants]) => fromVariants.flatMap(fromLabel => b.get(key)!.map(toLabel => {
    if(fromLabel.some(label=>label===null)||toLabel.some(label=>label===null))return null;
    const comparableFrom=fromLabel as string[],comparableTo=toLabel as string[];
    return { key, fromLabel:comparableFrom, toLabel:comparableTo, agrees:comparableFrom.every((label, i) => label.toLowerCase() === comparableTo[i].toLowerCase()) };
  }).filter((example):example is NonNullable<typeof example>=>example!==null)));
  if (!examples.length) return undefined;
  const agree = examples.filter(e => e.agrees).length;
  return { agree, compared: examples.length, ratio: agree / examples.length, examples: examples.slice(0, 20) };
}
export async function probe(options?: { candidateIds: string[]; append?: boolean }) {
  const inventory = readJson<Discovery>('out/U1/discovery.json'), z = new Zetaris();
  const config = readJson('config/thresholds.json'), universeConfig = readJson<any>('universes/U1_ny_taxi.json');
  const mode: NormalizationMode = universeConfig.normalizationContract.defaultMode;
  if (!universeConfig.normalizationContract.modes[mode]) throw new Error('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  const probes: Probe[] = options?.append ? readJson<{probes: Probe[]}>('out/U1/probes.json').probes : [];
  const candidates = options ? inventory.candidates.filter(c => options.candidateIds.includes(c.id) && !probes.some(p => p.relation.id === c.id)) : inventory.candidates;
  for (const relation of candidates) {
    const start = performance.now(), a = inventory.tables[relation.from.table], b = inventory.tables[relation.to.table];
    const rawKeys = keyValues(a, relation.from).filter(v => normalizeKey(v, mode) !== null);
    const seeds = [...new Set(rawKeys.map(v => normalizeKey(v, mode)!))].slice(0, config.sampleLimit);
    const result: Probe = { relation, utc: new Date().toISOString(), status: 'PASS', queries: [],
      overlap: { matched: 0, probed: seeds.length, ratio: seeds.length ? 0 : null, sampleKeys: seeds },
      typeCompat: { from: a.schema.find(c => c.name === relation.from.column)?.type ?? 'unknown', to: b.schema.find(c => c.name === relation.to.column)?.type ?? 'unknown', castable: false, normalization: mode },
      nullRate: { from: nullRate(a, relation.from, mode), to: nullRate(b, relation.to, mode), denominatorFrom: a.sample.rows.length, denominatorTo: b.sample.rows.length }, alerts: semanticAlerts(a), durationMs: 0 };
    let transportFailure:any;
    try {
      if (seeds.length) {
        for (const [endpoint, table] of [[relation.from, a], [relation.to, b]] as const) {
          const cols = [...new Set([endpoint.column, ...table.labels])];
          // Numeric format variants match string-backed catalogs without remote casts.
          const values = [...new Set([...rawKeys.map(String), ...seeds, ...(mode === 'integer' ? seeds.filter(k => /^-?\d+$/.test(k)).map(k => k + '.0') : [])])].slice(0, 50);
          const sql = `SELECT ${projection(endpoint.table, cols)} FROM ${endpoint.db}.${endpoint.table} WHERE ${endpoint.column} IN (${quotedValues(values)}) LIMIT ${config.probeLimit}`;
          result.queries.push(await z.runSql(sql, config.probeLimit));
        }
        const [fromQuery, toQuery] = result.queries;
        const fromMultiplicity = measureMultiplicity(fromQuery.rows, 0, mode), toMultiplicity = measureMultiplicity(toQuery.rows, 0, mode);
        const rowPairs = sharedRowPairs(fromQuery.rows, 0, toQuery.rows, 0, mode);
        result.multiplicity = { from: fromMultiplicity, to: toMultiplicity, sharedRowPairs: rowPairs.sharedRowPairs, pairCounts: rowPairs.pairCounts, manyToManyKeys: rowPairs.manyToManyKeys,
          bounded: { from: fromQuery.rows.length >= config.probeLimit, to: toQuery.rows.length >= config.probeLimit } };
        if (toMultiplicity.duplicateKeys.length) result.alerts.push('DUPLICATE_REFERENCED_KEYS_OBSERVED_IN_BOUNDED_RESPONSE');
        if (rowPairs.manyToManyKeys.length) result.alerts.push('MANY_TO_MANY_MULTIPLICITY_OBSERVED_IN_BOUNDED_RESPONSES');
        const targetKeys = new Set(toQuery.rows.map(row => normalizeKey(row[0], mode)).filter(v => v !== null));
        result.overlap.matched = seeds.filter(k => targetKeys.has(k)).length;
        result.overlap.ratio = result.overlap.matched / seeds.length;
        const fromCols = [...new Set([relation.from.column, ...a.labels])], toCols = [...new Set([relation.to.column, ...b.labels])];
        result.labelAgreement = compareLabels(fromQuery.rows, toQuery.rows, fromCols, toCols, relation.from, relation.to, a.labels, b.labels, mode);
        const both = [...rawKeys, ...toQuery.rows.map(row => row[0])].filter(v => normalizeKey(v, mode) !== null);
        const numericDomain = both.every(v => /^-?\d+(?:\.0+)?$/.test(String(v).trim()));
        result.typeCompat.castable = numericDomain || result.typeCompat.from === result.typeCompat.to;
      } else result.alerts.push('NO_NON_NULL_SOURCE_KEYS_IN_SAMPLE');
    } catch (error) { transportFailure=error; result.status = 'FAIL'; result.error = failure(error); }
    const stamp=new Date().toISOString(),digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const previousPath=path.join(ROOT,'.concordia','freshness','U1',relation.id+'.json');
    const previous=fs.existsSync(previousPath)?JSON.parse(fs.readFileSync(previousPath,'utf8')):null;
    // Fingerprint the bounded rows returned by this live probe, never the cached
    // discovery sample. Schema identity is limited to the allowlisted projection.
    const sourceVersion=digest(result.queries.map(q=>q.rows)),schemaVersion=digest([a.schema,b.schema]);
    const complete=result.status==='PASS';
    const freshness=assessFreshness(previous,{sourceVersion,schemaVersion,normalization:mode,observedAt:stamp,verdict:complete?classify(result,config).verdict:'INDETERMINADA',complete});
    result.freshness={...freshness,sourceVersion,schemaVersion,normalization:mode,observedAt:stamp};
    if(!complete){const transport=failure(transportFailure);result.error={...result.error,...assessPartialTransport({fragments:result.queries.map(q=>({requestId:q.requestId,rows:q.rows.length})),error:{status:errorStatus(transport),retryAfter:transport.retryAfter}})};}
    else {
      const next={sourceVersion,schemaVersion,normalization:mode,observedAt:stamp,verdict:classify(result,config).verdict,state:freshness.state,requestIds:result.queries.map(q=>q.requestId),rule:classify(result,config).rule};
      fs.mkdirSync(path.dirname(previousPath),{recursive:true});fs.appendFileSync(previousPath.replace(/\.json$/,'')+'.history.jsonl',JSON.stringify(next)+'\n');
      fs.writeFileSync(previousPath+'.tmp',JSON.stringify(next,null,2)+'\n');fs.renameSync(previousPath+'.tmp',previousPath);
    }
    result.durationMs = Math.round(performance.now() - start); probes.push(result);
    writeJson('out/U1/probes.json', { utc: new Date().toISOString(), live: true, llmApplicable: false, sampleWarning: 'Bounded nonrandom samples; no global coverage/uniqueness established', probes });
    console.log(result.status, relation.id, 'overlap', result.overlap.ratio, 'labels', result.labelAgreement?.ratio ?? 'absent', 'alerts', result.alerts.length);
  }
  return probes;
}
function errorStatus(error:any){return typeof error?.http==='number'?error.http:0;}
