// Configuration-driven bounded pipeline. Adding an input universe changes only
// its JSON contract; normalization and SQL policy are common engine behavior.
import fs from 'node:fs';
import path from 'node:path';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { measureMultiplicity, sharedRowPairs, compareLabels } from './probe/index.ts';
import { normalizeKey as normalizeByMode, type NormalizationMode } from './universe.ts';
import { readJson, writeJson, ROOT, failure, SafeError } from './runtime.ts';
import { recordFreshnessAttempt, sourceSchemaFingerprintFromDescription } from './reconcile/freshness-history.ts';
import { resolveUniverseManifest, validateUniverseConfig } from './registry/universes.ts';
import { legacyRelationContract, planLegacyProbe } from './relations/legacy.ts';
import { addSampleQualitySignals, executeProbe, LocalFixtureAdapter } from './relations/probes.ts';
import { ZetarisProbeAdapter, zetarisSourceQuery, zetarisTableSpecs } from './relations/adapters/zetaris.ts';
import { evaluateRelation } from './relations/decision.ts';
import { relationPolicyFromConfig } from './relations/policy.ts';
import { expectedDecisionMatches, selectExpectedDecision } from './eval/expected-decisions.ts';

export function universeConfig(id:string) {
  const manifest=resolveUniverseManifest(id);
  if(!manifest)throw new SafeError('INVALID_UNIVERSE');
  if(!manifest.source.configPath)throw new SafeError('UNIVERSE_MANIFEST_ONLY');
  const config=readJson(manifest.source.configPath);
  const issues=validateUniverseConfig(manifest,config);
  if(issues.length)throw new SafeError('UNIVERSE_CONFIG_INVALID',undefined,JSON.stringify(issues));
  return config;
}
export function normalizeKey(value:unknown,mode:NormalizationMode,contract:any) {
  if(!contract?.modes?.[mode])throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  return normalizeByMode(value,mode);
}
export const sourceQuery=(spec:any)=>zetarisSourceQuery(spec);
export async function discoverUniverse(id:string, dependencies:{client?:Pick<Zetaris,'describe'|'runSql'>;persist?:boolean;runId?:string;executionMode?:'LIVE'|'REPLAY'|'LOCAL'}={}) {
  const cfg=universeConfig(id),z=dependencies.client??new Zetaris();
  const result:any={utc:new Date().toISOString(),live:(dependencies.executionMode??'LIVE')==='LIVE',pending_llm:false,llm:'deterministic configured candidates; no generation needed',tables:{},candidates:cfg.relations,errors:[]};
  for(const [name,spec] of Object.entries<any>(cfg.tables)) {
    try {
      const metadata=await z.describe(spec.db,spec.physicalTable);
      const projection=spec.columns.map((c:any)=>identifier(c.name));
      if(!spec.baseSql && projection.some((c:string)=>!metadata.rows.some(r=>r[0]===c)))throw new SafeError('U2_ALLOWLIST_COLUMN_MISSING');
      const sample=await z.runSql(`SELECT ${projection.length?projection.join(', '):'1 AS row_present'} FROM ${sourceQuery(spec)} LIMIT ${cfg.sampleLimit}`,cfg.sampleLimit);
      result.tables[name]={columns:projection.length?projection:['row_present'],schema:spec.columns,sourceMetadata:metadata,derivedSchema:Boolean(spec.baseSql),sample,labels:spec.labels??[],keyColumns:spec.keyColumns,role:spec.role};
      console.log('PASS discover',id,name,sample.rows.length);
    }catch(error){result.errors.push({table:name,...failure(error)});break;}
  }
  if(dependencies.persist!==false)writeJson(`out/${id}/discovery.json`,result);
  if(result.errors.length)throw new SafeError('UNIVERSE_DISCOVERY_BLOCKED',undefined,JSON.stringify(result.errors));
  return result;
}
export interface UniverseProbeDependencies { inventory?: any; client?: Pick<Zetaris, 'runSql'>; persist?: boolean; recordFreshness?: boolean; relationIds?: readonly string[]; now?:()=>string; executionMode?: 'LIVE' | 'REPLAY' | 'LOCAL'; dataOrigin?: 'UNKNOWN' | 'PUBLIC' | 'USER' | 'SYNTHETIC'; }
export async function probeUniverse(id:string, dependencies:UniverseProbeDependencies = {}) {
  const cfg=universeConfig(id), inventory=dependencies.inventory??readJson(`out/${id}/discovery.json`), z=dependencies.client??new Zetaris(), thresholds=readJson('config/thresholds.json'),relationPolicy=relationPolicyFromConfig(thresholds);
  const selectedRelations=dependencies.relationIds?cfg.relations.filter((relation:any)=>dependencies.relationIds!.includes(relation.id)):cfg.relations;
  if(dependencies.relationIds&&selectedRelations.length!==new Set(dependencies.relationIds).size)throw new SafeError('UNIVERSE_RELATION_NOT_FOUND');
  const relationBound=resolveUniverseManifest(id)!.capabilityBounds?.BOUNDED_RELATION_PROBE?.maxRelationsPerRun;
  if(selectedRelations.length>relationBound!)throw new SafeError('RELATION_COUNT_EXCEEDS_CAPABILITY_BOUND');
  const manifest=resolveUniverseManifest(id)!;
  const tableSpecs=zetarisTableSpecs(cfg);
  const allowlist=Object.fromEntries(Object.entries<any>(cfg.tables).map(([table,spec])=>[`${spec.db}.${table}`,spec.columns.map((column:any)=>column.name)]));
  const result:any={utc:new Date().toISOString(),live:(dependencies.executionMode??'LIVE')==='LIVE',probes:[]};
  for(const relation of selectedRelations) {
    const a=inventory.tables[relation.from.table],b=inventory.tables[relation.to.table],mode=relation.normalization as NormalizationMode;
    const values=a.sample.rows.map((row:any[])=>row[a.columns.indexOf(relation.from.column)]).filter((value:any)=>value!==null&&value!==undefined);
    const seeds=[...new Set(values.map((value:any)=>normalizeKey(value,mode,cfg.normalizationContract)))].filter((value):value is string=>value!==null);
    const variants=mode==='integer-pad10'?[...values,...seeds,...seeds.map(value=>String(value).padStart(10,'0'))]:values;
    const filterValues=[...new Set(variants)].slice(0,cfg.probeLimit) as (string|number|boolean)[];
    const contractVersion=manifest.version.split('.').slice(0,2).join('.');
    const additionalColumns=Object.fromEntries([relation.from,relation.to].map(endpoint=>{
      const spec=cfg.tables[endpoint.table];return [`${endpoint.db}.${endpoint.table}`,spec.labels??[]];
    }));
    const filters=filterValues.length?Object.fromEntries([relation.from,relation.to].map(endpoint=>[
      `${endpoint.db}.${endpoint.table}`,{column:endpoint.column,values:filterValues}
    ])):{};
    const plan=planLegacyProbe(relation,id,contractVersion,mode,relation.minDistinctKeys??thresholds.minDistinctKeys,allowlist,cfg.probeLimit,additionalColumns,filters);
    const currentAt=dependencies.now?.()??new Date().toISOString();
    const execution=await executeProbe(plan,new ZetarisProbeAdapter(tableSpecs,z),{
      runId:`${id}:${relation.id}:${currentAt}`,checkedAt:currentAt,scope:'allowlisted bounded key lookup',executionMode:dependencies.executionMode??'LIVE',dataOrigin:dependencies.dataOrigin??manifest.source.dataOrigin
    });
    const readsBySource=new Map(execution.reads.map(read=>[read.sourceId,read]));
    const endpointReads=[relation.from,relation.to].map(endpoint=>readsBySource.get(`${endpoint.db}:${endpoint.table}:${endpoint===relation.from?'from':'to'}`));
    const queries=execution.reads.map(read=>({sql:read.statement??'',requestId:read.requestId??'',queryId:read.queryId??'',rows:read.tuples,durationMs:read.durationMs??0,utc:read.requestedAt??currentAt}));
    const fromRows=endpointReads[0]?.tuples??[],toRows=endpointReads[1]?.tuples??[];
    const fromMultiplicity=measureMultiplicity(fromRows,0,mode),toMultiplicity=measureMultiplicity(toRows,0,mode);
    const rowPairs=sharedRowPairs(fromRows,0,toRows,0,mode);
    const fromColumns=plan.endpoints[0].columns,toColumns=plan.endpoints[1].columns;
    const labelColumnsFrom=(cfg.tables[relation.from.table].labels??[]).filter((column:string)=>fromColumns.includes(column));
    const labelColumnsTo=(cfg.tables[relation.to.table].labels??[]).filter((column:string)=>toColumns.includes(column));
    const labelAgreement=compareLabels(fromRows,toRows,[...fromColumns],[...toColumns],relation.from,relation.to,labelColumnsFrom,labelColumnsTo,mode);
    const targetKeys=new Set(toRows.map(row=>normalizeKey(row[0],mode,cfg.normalizationContract)).filter((value):value is string=>value!==null));
    const matched=seeds.filter(key=>targetKeys.has(key)).length;
    const fromType=a.schema.find((column:any)=>column.name===relation.from.column)?.type??'unknown';
    const toType=b.schema.find((column:any)=>column.name===relation.to.column)?.type??'unknown';
    const typeCompatible=Boolean(cfg.normalizationContract?.modes?.[mode]);
    const alerts:string[]=[];
    if(execution.status==='PARTIAL'||execution.status==='ERROR')alerts.push('transport_incomplete');
    if(toMultiplicity.duplicateKeys.length)alerts.push('DUPLICATE_REFERENCED_KEYS_OBSERVED_IN_BOUNDED_RESPONSE');
    if(rowPairs.manyToManyKeys.length)alerts.push('MANY_TO_MANY_MULTIPLICITY_OBSERVED_IN_BOUNDED_RESPONSES');
    const probe:any={relation,utc:currentAt,status:execution.status==='COMPLETE'?'PASS':'INCOMPLETE',queries,normalization:mode,
      overlap:{matched,probed:seeds.length,ratio:seeds.length?matched/seeds.length:null,sampleKeys:seeds},
      multiplicity:{from:fromMultiplicity,to:toMultiplicity,sharedRowPairs:rowPairs.sharedRowPairs,pairCounts:rowPairs.pairCounts,manyToManyKeys:rowPairs.manyToManyKeys,bounded:{from:fromRows.length>=plan.limit,to:toRows.length>=plan.limit}},
      labelAgreement,typeCompat:{from:fromType,to:toType,castable:typeCompatible,normalization:mode},
      nullRate:{from:a.sample.rows.length?fromMultiplicity.nullRows/a.sample.rows.length:null,to:b.sample.rows.length?toMultiplicity.nullRows/b.sample.rows.length:null},alerts,
      error:execution.errors.length?{code:'ADAPTER_READ_FAILED',failedSources:execution.errors.map(error=>({sourceRef:error.sourceRef,code:error.adapterCode,http:error.http,retryAfter:error.retryAfter}))}:undefined};
    const qualitySignals:string[]=[];
    if(labelAgreement&&labelAgreement.ratio<(thresholds.misleadingLabelAgreement??0))qualitySignals.push('LABEL_CONFLICT');
    else if(labelAgreement&&labelAgreement.ratio<(thresholds.sustainedLabelAgreement??1))qualitySignals.push('LABEL_UNCERTAIN');
    if(rowPairs.manyToManyKeys.length)qualitySignals.push('MANY_TO_MANY');
    if(toMultiplicity.duplicateKeys.length)qualitySignals.push('DUPLICATE_REFERENCED_KEYS');
    if(!typeCompatible)qualitySignals.push('TYPE_INCOMPATIBLE');
    if(alerts.length)qualitySignals.push('SAMPLE_ALERT');
    addSampleQualitySignals(execution.bundle,qualitySignals,currentAt);
    const contract=legacyRelationContract(relation,manifest.manifestId,contractVersion,mode,relation.minDistinctKeys??thresholds.minDistinctKeys);
    const decision=evaluateRelation(contract,[execution.bundle],relationPolicy);
    probe.decision=decision;probe.relationContract=contract;probe.typedEvidence=execution.bundle;
    const complete=execution.status==='COMPLETE';
    const attempt=dependencies.persist===false&&!dependencies.recordFreshness?null:recordFreshnessAttempt({universeId:manifest.manifestId,relationId:relation.id,contract,evidence:execution.bundle,decision,policy:relationPolicy,reads:execution.reads,errors:execution.errors,sourceSchemaFingerprints:[sourceSchemaFingerprintFromDescription(`${relation.from.db}:${relation.from.table}:from`,`${relation.from.db}.${relation.from.table}`,a.sourceMetadata?.rows,'LEGACY_DESCRIBE_CAPTURE',a.sourceMetadata?.utc),sourceSchemaFingerprintFromDescription(`${relation.to.db}:${relation.to.table}:to`,`${relation.to.db}.${relation.to.table}`,b.sourceMetadata?.rows,'LEGACY_DESCRIBE_CAPTURE',b.sourceMetadata?.utc)],checkedAt:currentAt});
    probe.freshness=attempt?{state:attempt.comparison,requiresReview:attempt.validity.requiresReview||attempt.comparison==='CHANGED_REQUIRES_REVIEW',preserveHistorical:true,supersedePrevious:false,reusedAsFresh:false,observedAt:attempt.validity.observedAt,checkedAt:attempt.validity.checkedAt,attemptRef:attempt.attemptId,lastCompleteAttemptRef:attempt.latestCompleteAttemptRef,sourceToken:attempt.validity.sourceToken,sourceFingerprint:attempt.validity.sourceFingerprint,fingerprintScope:attempt.fingerprintScope,scopeDescription:attempt.scopeDescription}:{state:complete?'FIRST_CHECK':'INCOMPLETA',requiresReview:!complete,preserveHistorical:true,supersedePrevious:false,reusedAsFresh:false,observedAt:null,checkedAt:currentAt};
    result.probes.push(probe);if(dependencies.persist!==false)writeJson(`out/${id}/probes.json`,result);
  }
  const output:any={utc:new Date().toISOString(),pending_llm:false,explanationSource:'deterministic-template',relations:result.probes.map((probe:any)=>{
    const decision={verdict:probe.decision?.verdict??'INDETERMINADA',rule:probe.decision?.reasonCodes[0]??'typed_decision_missing'};
    const freshness=probe.freshness;
    const effective=freshness?.state==='DEGRADADA'||freshness?.state==='INCOMPLETA'?{verdict:'INDETERMINADA',rule:freshness.state==='DEGRADADA'?'freshness_changed_requires_review':'transport_incomplete'}:decision;
    return {relationId:probe.relation.id,from:probe.relation.from,to:probe.relation.to,...effective,evidence:probe,normalization:probe.normalization,freshness,explanation:`${effective.verdict}: ${probe.overlap.matched}/${probe.overlap.probed} bounded keys; comparison ${probe.normalization}. Freshness ${freshness?.state??'not assessed'}; no global coverage claim.`,proposedBy:'heuristic-configured'};
  })};
  if(dependencies.persist!==false)writeJson(`out/${id}/relaciones.json`,output);
  if(dependencies.persist!==false)fs.writeFileSync(path.join(ROOT,`out/${id}/relaciones.md`),['# Relaciones '+id,'','Sin generación. Comparaciones de muestras acotadas, no uniones remotas.','',...output.relations.map((relation:any)=>`- ${relation.relationId}: ${relation.explanation}`)].join('\n')+'\n');
  return output;
}
export function evaluateUniverse(id:string) {
  const cases=readJson(`eval/cases/${id}.json`),relations=readJson(`out/${id}/relaciones.json`).relations,thresholds=readJson('config/thresholds.json'),relationPolicy=relationPolicyFromConfig(thresholds);
  const results=cases.cases.map((c:any)=>{
    const relation=relations.find((item:any)=>item.relationId===c.relationId);
    const probe=relation?.evidence,contract=relation?.relationContract??probe?.relationContract,evidence=relation?.typedEvidence??probe?.typedEvidence;
    const typed=Boolean(contract&&evidence);
    const decision=typed?evaluateRelation(contract,[evidence],relationPolicy):undefined;
    const freshness=relation?.freshness??probe?.freshness;
    const staleFreshness=freshness?.state==='DEGRADADA'||freshness?.state==='INCOMPLETA';
    const actual=!relation?'NOT_FOUND':!typed?'NOT_EVALUABLE':staleFreshness?'INDETERMINADA':decision!.verdict;
    const actualReasonCodes=!relation?['relation_not_found']:!typed?['typed_evidence_missing']:staleFreshness?[freshness?.state==='DEGRADADA'?'freshness_changed_requires_review':'transport_incomplete']:decision!.reasonCodes;
    const expectation=selectExpectedDecision(c,evidence?.contractVersion??null);
    const expectationResult=expectedDecisionMatches(expectation,actual,actualReasonCodes);
    const typedDecision=decision?{verdict:decision.verdict,status:decision.status,reasonCodes:decision.reasonCodes,contractVersion:decision.contractVersion,policyVersion:decision.policyVersion}:null;
    return {id:c.id,expected:expectation.expected,legacyExpected:c.expected??[],expectationContractVersion:expectation.contractVersion,expectationSource:expectation.source,expectationProvenance:expectation.provenance,expectationReasonCodesMet:expectationResult.reasonCodesMet,typedDecision,actual,actualReasonCodes,pass:Boolean(relation&&typed&&expectationResult.pass),...relation&&!typed?{legacyVerdict:relation.verdict??null}:{},evaluationMode:typed?'REPLAY':'NOT_EVALUABLE',evaluationPolicyVersion:relationPolicy.policyVersion,sourcePolicyVersion:relation?.decision?.policyVersion??probe?.decision?.policyVersion??null,sourceContractVersion:contract?.contractVersion??null,sourceEvidenceContractVersion:evidence?.contractVersion??null,sourceExecutionMode:evidence?.runRef?.executionMode??null,sourceDataOrigin:evidence?.runRef?.dataOrigin??null};
  });
  const correct=results.filter((r:any)=>r.pass).length,incomplete=results.some((r:any)=>r.actual==='NOT_EVALUABLE'||r.expectationSource==='UNCONFIGURED_CONTRACT_VERSION');
  const result={utc:new Date().toISOString(),evaluationMode:'REPLAY',evaluationSet:cases.evaluationSet??'LEGACY_EXPECTATION_CHECK',evaluationMeaning:cases.evaluationMeaning??'Configured expected-decision regression check; not truth adjudication or accuracy.',evaluationPolicyVersion:relationPolicy.policyVersion,status:incomplete?'INCOMPLETE':correct>=cases.minCorrect?'PASS':'FAIL',expectationCoverage:incomplete?'INCOMPLETE':'CONFIGURED',correct,total:results.length,results};
  writeJson(`out/${id}/eval.json`,result); if(result.status!=='PASS')throw new SafeError('UNIVERSE_EVAL_FAILED'); console.log(JSON.stringify(result)); return result;
}


/** Executes a config-declared LOCAL+SYNTHETIC fixture through the same probe and relation evaluator; performs no I/O beyond reading its JSON config. */
export async function evaluateLocalFixtureUniverse(id: string, policyVersion?: string, options:{persistFreshness?:boolean;relationIds?:readonly string[];now?:()=>string;runId?:string}={}) {
  const manifest = resolveUniverseManifest(id);
  if (!manifest || manifest.source.adapterId !== 'local-files' || !manifest.capabilities.includes('LOCAL_EVALUATION') || !manifest.capabilities.includes('RELATION_EVALUATION')) throw new SafeError('LOCAL_RELATION_EVALUATION_CAPABILITY_REQUIRED');
  if (manifest.source.dataOrigin !== 'SYNTHETIC') throw new SafeError('LOCAL_FIXTURE_ORIGIN_MUST_BE_SYNTHETIC');
  const cfg = universeConfig(id);
  // Config files keep their registry alias as their own ID. Callers may select
  // that alias or the manifest's stable ID; retain the requested ID in results.
  if (!manifest.aliases.includes(cfg.id) || !cfg.fixtureCapturedAt || !Array.isArray(cfg.relations) || !cfg.relations.length || !Object.values<any>(cfg.tables ?? {}).every(table => Array.isArray(table.fixtureRows))) throw new SafeError('LOCAL_FIXTURE_CONFIG_INVALID');
  if (JSON.stringify([...cfg.relations.map((relation: any) => relation.id)].sort()) !== JSON.stringify([...manifest.relationIds].sort())) throw new SafeError('MANIFEST_RELATION_IDS_MISMATCH');
  const contractVersion = manifest.version.split('.').slice(0, 2).join('.');
  const activePolicyVersion = policyVersion ?? cfg.relationPolicyVersion;
  if (!/^\d+\.\d+$/.test(activePolicyVersion ?? '')) throw new SafeError('LOCAL_FIXTURE_POLICY_VERSION_REQUIRED');
  const allowlist = Object.fromEntries(Object.entries<any>(cfg.tables).map(([table, spec]) => [`${spec.db}.${table}`, spec.columns.map((column: any) => column.name)]));
  const results = [];
  const selectedRelations=options.relationIds?cfg.relations.filter((relation:any)=>options.relationIds!.includes(relation.id)):cfg.relations;
  if(options.relationIds&&selectedRelations.length!==new Set(options.relationIds).size)throw new SafeError('UNIVERSE_RELATION_NOT_FOUND');
  for (const relation of selectedRelations) {
    const mode = relation.normalization as NormalizationMode;
    if (!cfg.normalizationContract?.modes?.[mode]) throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
    const minimum = relation.minDistinctKeys ?? cfg.minDistinctKeys ?? 1;
    const contract = legacyRelationContract(relation, manifest.manifestId, contractVersion, mode, minimum);
    const plan = planLegacyProbe(relation, manifest.manifestId, contractVersion, mode, minimum, allowlist, cfg.probeLimit);
    const fixtures: Record<string, readonly unknown[][]> = {};
    for (const [index, endpoint] of [contract.from, contract.to].entries()) {
      const source = index === 0 ? relation.from : relation.to;
      const table = cfg.tables[source.table];
      const columnIndex = table.columns.findIndex((column: any) => column.name === source.column);
      if (columnIndex < 0) throw new SafeError('LOCAL_FIXTURE_KEY_OUTSIDE_CONFIG');
      fixtures[`${endpoint.sourceId}:${endpoint.objectId}`] = table.fixtureRows.map((row: unknown[]) => [row[columnIndex]]);
    }
    const runId = options.runId?`${options.runId}:${relation.id}`:`fixture:${manifest.manifestId}:${relation.id}`;
    const checkedAt=options.now?.()??(options.persistFreshness?new Date().toISOString():cfg.fixtureCapturedAt);
    const execution = await executeProbe(plan, new LocalFixtureAdapter(fixtures), { runId, checkedAt, scope: 'config-declared synthetic fixture', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
    const activePolicy=relationPolicyFromConfig({ policyVersion: activePolicyVersion, minimumOverlapRatio: cfg.minimumOverlapRatio });
    const decision = evaluateRelation(contract, [execution.bundle], activePolicy);
    if(options.persistFreshness)recordFreshnessAttempt({universeId:manifest.manifestId,relationId:relation.id,contract,evidence:execution.bundle,decision,policy:activePolicy,reads:execution.reads,errors:execution.errors,checkedAt,now:options.now});
    results.push({ relationId: relation.id, contract, evidence: execution.bundle, probeStatus: execution.status, decision });
  }
  return { manifestId: manifest.manifestId, universeId: id, configId: cfg.id, version: manifest.version, executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const, results };
}
