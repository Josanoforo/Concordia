import { Zetaris, type SqlResult } from '../clients/zetaris.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Candidate, Discovery, Endpoint, LiveTable } from '../discovery/index.ts';
import type { Decision, EvidenceBundle, RelationContract } from '../contracts/types.ts';
import { failure, readJson, writeJson, ROOT, SafeError } from '../runtime.ts';
import { normalizeKey, type NormalizationMode } from '../universe.ts';
import { assessPartialTransport } from './evidence-contract.ts';
import { recordFreshnessAttempt, sourceSchemaFingerprintFromDescription } from '../reconcile/freshness-history.ts';
import { resolveUniverseManifest, validateUniverseConfig } from '../registry/universes.ts';
import { legacyRelationContract, planLegacyProbe } from '../relations/legacy.ts';
import { addSampleQualitySignals, executeProbe } from '../relations/probes.ts';
import { ZetarisProbeAdapter, zetarisTableSpecs } from '../relations/adapters/zetaris.ts';
import { evaluateRelation } from '../relations/decision.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { evaluateKeyRules, type KeyRules } from './key-rules.ts';
import { checkKeyContract, type KeyContractResult } from '../relations/key-contract.ts';
import { classify } from './verdicts.ts';
import { incompletenessOfDecision, type Incompleteness } from '../relations/incompleteness.ts';
export type Probe = {
  relation: Candidate; utc: string; status: string; queries: SqlResult[]; error?: object;
  overlap: { matched: number; probed: number; ratio: number | null; sampleKeys: string[] };
  multiplicity?: { from: RowMultiplicity; to: RowMultiplicity; sharedRowPairs: number; pairCounts: { key: string; fromRows: number; toRows: number; pairs: number }[]; manyToManyKeys: string[]; bounded: { from: boolean; to: boolean } };
  containment?: Containment; keyRules?: KeyRules; keyContracts?: { from: KeyContractResult; to: KeyContractResult };
  labelAgreement?: { agree: number; compared: number; ratio: number; examples: { key: string; fromLabel: string[]; toLabel: string[]; agrees: boolean }[] };
  typeCompat: { from: string; to: string; castable: boolean; normalization: string };
  nullRate: { from: number | null; to: number | null; denominatorFrom: number; denominatorTo: number };
  alerts: string[]; durationMs: number; freshness?: any; decision?: Decision; incompleteness?: Incompleteness; relationContract?: RelationContract; typedEvidence?: EvidenceBundle;
};
export type RowMultiplicity = { rows: number; nonNullRows: number; nullRows: number; emptyRows: number; distinctKeys: number; duplicateKeys: { key: string; rows: number }[]; maxRowsPerKey: number };
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
  return { rows: rows.length, nonNullRows: rows.length - nullRows - emptyRows, nullRows, emptyRows, distinctKeys: counts.size, duplicateKeys, maxRowsPerKey: Math.max(0, ...counts.values()) };
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
export type ContainmentRatio = { shared: number; of: number; ratio: number | null };
/** Directional containment of two key samples. B->A and Jaccard are null when B was fetched by A's keys, because B is then already filtered by A and the inverse is not a measurement. */
export type Containment = { distinctFrom: number; distinctTo: number; sharedKeys: number; aToB: ContainmentRatio; bToA: ContainmentRatio | null; jaccard: number | null; comparable: boolean; reason?: 'TARGET_FILTERED_BY_SOURCE_KEYS' };
export function measureContainment(fromRows: any[][], fromIndex: number, toRows: any[][], toIndex: number, mode: NormalizationMode, options: { targetFilteredBySource: boolean }): Containment {
  const distinct = (rows: any[][], index: number) => new Set(rows.map(row => normalizeKey(row[index], mode)).filter((key): key is string => key !== null));
  const from = distinct(fromRows, fromIndex), to = distinct(toRows, toIndex);
  const shared = [...from].filter(key => to.has(key)).length;
  const ratio = (of: number): ContainmentRatio => ({ shared, of, ratio: of ? shared / of : null });
  const aToB = ratio(from.size);
  if (options.targetFilteredBySource) return { distinctFrom: from.size, distinctTo: to.size, sharedKeys: shared, aToB, bToA: null, jaccard: null, comparable: false, reason: 'TARGET_FILTERED_BY_SOURCE_KEYS' };
  const union = from.size + to.size - shared;
  return { distinctFrom: from.size, distinctTo: to.size, sharedKeys: shared, aToB, bToA: ratio(to.size), jaccard: union ? shared / union : null, comparable: true };
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
export interface ProbeDependencies { inventory?: Discovery; client?: Pick<Zetaris, 'runSql'>; persist?: boolean; recordFreshness?: boolean; now?:()=>string; }
export async function probe(options?: { candidateIds: string[]; append?: boolean }, dependencies: ProbeDependencies = {}) {
  const inventory=dependencies.inventory??readJson<Discovery>('out/U1/discovery.json'),z=dependencies.client??new Zetaris();
  const config=readJson('config/thresholds.json'),relationPolicy=relationPolicyFromConfig(config),universeConfig=readJson<any>('universes/U1_ny_taxi.json');
  const manifest=resolveUniverseManifest('U1')!,configIssues=validateUniverseConfig(manifest,universeConfig);
  if(configIssues.length)throw new SafeError('UNIVERSE_CONFIG_INVALID',undefined,JSON.stringify(configIssues));
  const mode:NormalizationMode=universeConfig.normalizationContract.defaultMode;
  if(!universeConfig.normalizationContract.modes[mode])throw new Error('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  const probes:Probe[]=options?.append&&dependencies.persist!==false?readJson<{probes:Probe[]}>('out/U1/probes.json').probes:[];
  const candidates=options?inventory.candidates.filter(candidate=>options.candidateIds.includes(candidate.id)&&!probes.some(probe=>probe.relation.id===candidate.id)):inventory.candidates;
  const relationBound=manifest.capabilityBounds?.BOUNDED_RELATION_PROBE?.maxRelationsPerRun;
  if(candidates.length>relationBound!)throw new SafeError('RELATION_COUNT_EXCEEDS_CAPABILITY_BOUND');
  const contractVersion=manifest.version.split('.').slice(0,2).join('.');
  const adapter=new ZetarisProbeAdapter(zetarisTableSpecs(universeConfig),z);
  for(const relation of candidates){
    const start=performance.now(),a=inventory.tables[relation.from.table],b=inventory.tables[relation.to.table];
    const rawKeys=keyValues(a,relation.from).filter(value=>normalizeKey(value,mode)!==null);
    const seeds=[...new Set(rawKeys.map(value=>normalizeKey(value,mode)!))].slice(0,config.sampleLimit);
    const result:Probe={relation,utc:new Date().toISOString(),status:'INCOMPLETE',queries:[],overlap:{matched:0,probed:seeds.length,ratio:seeds.length?0:null,sampleKeys:seeds},
      typeCompat:{from:a.schema.find(column=>column.name===relation.from.column)?.type??'unknown',to:b.schema.find(column=>column.name===relation.to.column)?.type??'unknown',castable:false,normalization:mode},
      nullRate:{from:nullRate(a,relation.from,mode),to:nullRate(b,relation.to,mode),denominatorFrom:a.sample.rows.length,denominatorTo:b.sample.rows.length},alerts:semanticAlerts(a),durationMs:0};
    const fromObject=`${relation.from.db}.${relation.from.table}`,toObject=`${relation.to.db}.${relation.to.table}`;
    const approved=(table:string)=>universeConfig.tables[table].columns.map((column:any)=>column.name);
    const allowlist={[fromObject]:approved(relation.from.table),[toObject]:approved(relation.to.table)};
    const additionalColumns={[fromObject]:a.labels,[toObject]:b.labels};
    const rawVariants=[...rawKeys.map(String),...seeds,...(mode==='integer'?seeds.filter(key=>/^-?\d+$/.test(key)).map(key=>key+'.0'):[])];
    const filterValues=[...new Set(rawVariants)].slice(0,universeConfig.probeLimit);
    const filters=filterValues.length?{
      [fromObject]:{column:relation.from.column,values:filterValues},
      [toObject]:{column:relation.to.column,values:filterValues}
    }:{};
    const plan=planLegacyProbe(relation,'U1',contractVersion,mode,config.minDistinctKeys,allowlist,universeConfig.probeLimit,additionalColumns,filters);
    const currentAt=dependencies.now?.()??new Date().toISOString();
    const execution=await executeProbe(plan,adapter,{runId:`U1:${relation.id}:${currentAt}`,checkedAt:currentAt,scope:'allowlisted bounded key lookup',executionMode:'LIVE',dataOrigin:manifest.source.dataOrigin});
    result.utc=currentAt;
    result.queries=execution.reads.map(read=>({sql:read.statement??'',requestId:read.requestId??'',queryId:read.queryId??'',rows:read.tuples as any[][],durationMs:read.durationMs??0,utc:read.requestedAt??currentAt}));
    const fromSource=`${relation.from.db}:${relation.from.table}:from`,toSource=`${relation.to.db}:${relation.to.table}:to`;
    const fromRows=execution.bundle.observations.find(observation=>observation.sourceRef===fromSource)?.measuredTuples??[];
    const toRows=execution.bundle.observations.find(observation=>observation.sourceRef===toSource)?.measuredTuples??[];
    const fromCols=plan.endpoints[0].columns as string[],toCols=plan.endpoints[1].columns as string[];
    const fromMultiplicity=measureMultiplicity(fromRows as any[][],0,mode),toMultiplicity=measureMultiplicity(toRows as any[][],0,mode);
    const rowPairs=sharedRowPairs(fromRows as any[][],0,toRows as any[][],0,mode);
    result.multiplicity={from:fromMultiplicity,to:toMultiplicity,sharedRowPairs:rowPairs.sharedRowPairs,pairCounts:rowPairs.pairCounts,manyToManyKeys:rowPairs.manyToManyKeys,bounded:{from:fromRows.length>=plan.limit,to:toRows.length>=plan.limit}};
    result.keyRules=evaluateKeyRules(fromRows as any[][],toRows as any[][],mode,{targetBounded:result.multiplicity.bounded.to});
    const declared=(endpoint:Endpoint)=>universeConfig.tables[endpoint.table]?.keyContract?.[endpoint.column];
    if(declared(relation.from)||declared(relation.to))result.keyContracts={from:checkKeyContract(relation.from.column,declared(relation.from),fromMultiplicity),to:checkKeyContract(relation.to.column,declared(relation.to),toMultiplicity)};
    result.containment=measureContainment(fromRows as any[][],0,toRows as any[][],0,mode,{targetFilteredBySource:filterValues.length>0});
    if(toMultiplicity.duplicateKeys.length)result.alerts.push('DUPLICATE_REFERENCED_KEYS_OBSERVED_IN_BOUNDED_RESPONSE');
    if(rowPairs.manyToManyKeys.length)result.alerts.push('MANY_TO_MANY_MULTIPLICITY_OBSERVED_IN_BOUNDED_RESPONSES');
    const targetKeys=new Set(toRows.map(row=>normalizeKey(row[0],mode)).filter((value):value is string=>value!==null));
    result.overlap.matched=seeds.filter(key=>targetKeys.has(key)).length;
    result.overlap.ratio=seeds.length?result.overlap.matched/seeds.length:null;
    result.labelAgreement=compareLabels(fromRows as any[][],toRows as any[][],fromCols,toCols,relation.from,relation.to,a.labels,b.labels,mode);
    const both=[...rawKeys,...toRows.map(row=>row[0])].filter(value=>normalizeKey(value,mode)!==null);
    const numericDomain=both.every(value=>/^-?\d+(?:\.0+)?$/.test(String(value).trim()));
    result.typeCompat.castable=numericDomain||result.typeCompat.from===result.typeCompat.to;
    if(execution.errors.length)result.alerts.push('transport_incomplete');
    result.status=execution.status==='COMPLETE'?'PASS':'INCOMPLETE';
    const qualitySignals:string[]=[];
    if(result.labelAgreement&&result.labelAgreement.ratio<config.misleadingLabelAgreement)qualitySignals.push('LABEL_CONFLICT');
    else if(result.labelAgreement&&result.labelAgreement.ratio<config.sustainedLabelAgreement)qualitySignals.push('LABEL_UNCERTAIN');
    if(rowPairs.manyToManyKeys.length)qualitySignals.push('MANY_TO_MANY');
    if(toMultiplicity.duplicateKeys.length)qualitySignals.push('DUPLICATE_REFERENCED_KEYS');
    if(!result.typeCompat.castable)qualitySignals.push('TYPE_INCOMPATIBLE');
    if(result.alerts.length)qualitySignals.push('SAMPLE_ALERT');
    addSampleQualitySignals(execution.bundle,qualitySignals,currentAt);
    const contract=legacyRelationContract(relation,'concordia.universe.ny-taxi',contractVersion,mode,config.minDistinctKeys);
    result.decision=evaluateRelation(contract,[execution.bundle],relationPolicy);
    const incompleteness=incompletenessOfDecision(result.decision,contract,[execution.bundle]);if(incompleteness)result.incompleteness=incompleteness;
    result.relationContract=contract;result.typedEvidence=execution.bundle;
    const stamp=currentAt,complete=execution.status==='COMPLETE';
    const attempt=dependencies.persist===false&&!dependencies.recordFreshness?null:recordFreshnessAttempt({universeId:manifest.manifestId,relationId:relation.id,contract,evidence:execution.bundle,decision:result.decision!,policy:relationPolicy,reads:execution.reads,errors:execution.errors,sourceSchemaFingerprints:[sourceSchemaFingerprintFromDescription(`${relation.from.db}:${relation.from.table}:from`,`${relation.from.db}.${relation.from.table}`,a.schema,'LEGACY_DESCRIBE_CAPTURE',inventory.utc),sourceSchemaFingerprintFromDescription(`${relation.to.db}:${relation.to.table}:to`,`${relation.to.db}.${relation.to.table}`,b.schema,'LEGACY_DESCRIBE_CAPTURE',inventory.utc)],checkedAt:stamp});
    result.freshness=attempt?{state:attempt.comparison,requiresReview:attempt.validity.requiresReview||attempt.comparison==='CHANGED_REQUIRES_REVIEW',preserveHistorical:true,supersedePrevious:false,reusedAsFresh:false,observedAt:attempt.validity.observedAt,checkedAt:attempt.validity.checkedAt,attemptRef:attempt.attemptId,lastCompleteAttemptRef:attempt.latestCompleteAttemptRef,sourceToken:attempt.validity.sourceToken,sourceFingerprint:attempt.validity.sourceFingerprint,fingerprintScope:attempt.fingerprintScope,scopeDescription:attempt.scopeDescription}: {state:complete?'FIRST_CHECK':'INCOMPLETA',requiresReview:!complete,preserveHistorical:true,supersedePrevious:false,reusedAsFresh:false,observedAt:null,checkedAt:stamp};
    if(!complete){const failed=execution.errors[0];const partial=assessPartialTransport({fragments:result.queries.map(query=>({requestId:query.requestId,rows:query.rows.length})),error:{status:failed?.http??0,retryAfter:failed?.retryAfter}});result.error={...partial,failedSources:execution.errors.map(error=>({sourceRef:error.sourceRef,code:error.adapterCode,http:error.http,retryAfter:error.retryAfter}))};}
    result.durationMs=Math.round(performance.now()-start);probes.push(result);
    if(dependencies.persist!==false)writeJson('out/U1/probes.json',{utc:new Date().toISOString(),live:true,llmApplicable:false,sampleWarning:'Bounded nonrandom samples; no global coverage/uniqueness established',probes});
    console.log(result.status,relation.id,'overlap',result.overlap.ratio,'labels',result.labelAgreement?.ratio??'absent','alerts',result.alerts.length);
  }
  return probes;
}function errorStatus(error:any){return typeof error?.http==='number'?error.http:0;}
