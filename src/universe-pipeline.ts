// Configuration-driven bounded pipeline. Adding an input universe changes only
// its JSON contract; normalization and SQL policy are common engine behavior.
import fs from 'node:fs';
import path from 'node:path';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { measureMultiplicity, sharedRowPairs, compareLabels, measureContainment } from './probe/index.ts';
import { evaluateKeyRules } from './probe/key-rules.ts';
import { checkKeyContract } from './relations/key-contract.ts';
import { normalizeKey as normalizeByMode, type NormalizationMode } from './universe.ts';
import { readJson, writeJson, ROOT, failure, SafeError } from './runtime.ts';
import { recordFreshnessAttempt, sourceSchemaFingerprintFromDescription } from './reconcile/freshness-history.ts';
import { resolveUniverseManifest, validateUniverseConfig } from './registry/universes.ts';
import { legacyRelationContract, planLegacyProbe } from './relations/legacy.ts';
import { ensureDispersedSeeds, estimateSeedQueries, resolveProbeMode, seedTargetsOf, seedValues } from './probe/sampling.ts';
import { attachFullEvidence, measureFullEvidence } from './probe/full-evidence.ts';
import type { ProfileCache } from './probe/column-profile.ts';
import { addSampleQualitySignals, distinctKeysScope, executeProbe, LocalFixtureAdapter, withDistinctKeysSource } from './relations/probes.ts';
import { ZetarisProbeAdapter, zetarisSourceQuery, zetarisTableSpecs } from './relations/adapters/zetaris.ts';
import { evaluateRelation } from './relations/decision.ts';
import { relationPolicyFromConfig } from './relations/policy.ts';
import { expectedDecisionMatches, selectExpectedDecision } from './eval/expected-decisions.ts';

/** Relations of a human review overlay (src/agent/review-overlay.ts), in force only inside withReviewedRelations for one universe; absent means the config's own relations, untouched. */
const reviewedRelations=new Map<string,any[]>();
export async function withReviewedRelations<T>(id:string,relations:any[],fn:()=>Promise<T>):Promise<T> {
  const manifest=resolveUniverseManifest(id);
  if(!manifest)throw new SafeError('INVALID_UNIVERSE');
  if(reviewedRelations.has(manifest.manifestId))throw new SafeError('REVIEW_ALREADY_ACTIVE');
  reviewedRelations.set(manifest.manifestId,relations);
  try{return await fn();}finally{reviewedRelations.delete(manifest.manifestId);}
}
export function universeConfig(id:string) {
  const manifest=resolveUniverseManifest(id);
  if(!manifest)throw new SafeError('INVALID_UNIVERSE');
  if(!manifest.source.configPath)throw new SafeError('UNIVERSE_MANIFEST_ONLY');
  const config=readJson(manifest.source.configPath);
  const reviewed=reviewedRelations.get(manifest.manifestId);
  if(reviewed){config.relations=structuredClone(reviewed);for(const relation of reviewed)for(const side of [relation.from,relation.to]){const keys=config.tables?.[side.table]?.keyColumns;if(Array.isArray(keys)&&!keys.includes(side.column))keys.push(side.column);}}
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
export interface UniverseProbeDependencies { /** Replaces the configured relations for this call (diagnostic scripts probing one hypothetical pair through the same path). */ relations?: readonly any[]; /** P2: false keeps the first-rows discovery sample as the seed even in distinct-keys mode (no dispersed-key read; diagnostic scripts with a fixed SQL ceiling). Default true. */ dispersedSeeds?: boolean; /** P3: whole-table coverage and uniqueness measured by aggregate queries per relation (3 to 5 SQL each), attached to the evidence before the decision. Off by default. */ fullEvidence?: boolean; /** E1-06: per-run whole-table profile cache shared by every relation, so a target referenced by several relations is scanned once. */ profileCache?: ProfileCache; /** F1x (MIN, MAX, average length) instead of F1 in the same scan. */ extendedProfile?: boolean; /** Per-run override of the manifest probeMode (tests and callers); "distinct-keys" reads the source endpoint as the distinct sampled keys. */ probeMode?: 'distinct-keys'; inventory?: any; client?: Pick<Zetaris, 'runSql'>; persist?: boolean; recordFreshness?: boolean; relationIds?: readonly string[]; now?:()=>string; executionMode?: 'LIVE' | 'REPLAY' | 'LOCAL'; dataOrigin?: 'UNKNOWN' | 'PUBLIC' | 'USER' | 'SYNTHETIC'; /** Explicit per-run override of cfg.probeLimit (1..100) for configured relation probes only. */ probeLimit?: number; }
export async function probeUniverse(id:string, dependencies:UniverseProbeDependencies = {}) {
  const cfg=universeConfig(id), inventory=dependencies.inventory??readJson(`out/${id}/discovery.json`), z=dependencies.client??new Zetaris(), thresholds=readJson('config/thresholds.json'),relationPolicy=relationPolicyFromConfig(thresholds);
  const configuredRelations=dependencies.relations??cfg.relations;
  const selectedRelations=dependencies.relationIds?configuredRelations.filter((relation:any)=>dependencies.relationIds!.includes(relation.id)):configuredRelations;
  if(dependencies.relationIds&&selectedRelations.length!==new Set(dependencies.relationIds).size)throw new SafeError('UNIVERSE_RELATION_NOT_FOUND');
  const relationBound=resolveUniverseManifest(id)!.capabilityBounds?.BOUNDED_RELATION_PROBE?.maxRelationsPerRun;
  if(selectedRelations.length>relationBound!)throw new SafeError('RELATION_COUNT_EXCEEDS_CAPABILITY_BOUND');
  const manifest=resolveUniverseManifest(id)!;
  const tableSpecs=zetarisTableSpecs(cfg);
  const allowlist=Object.fromEntries(Object.entries<any>(cfg.tables).map(([table,spec])=>[`${spec.db}.${table}`,spec.columns.map((column:any)=>column.name)]));
  const probeLimit:number=dependencies.probeLimit??cfg.probeLimit;
  // Blind universes (an exploration catalog that declares postComa.blind and no configured relation) read the source as distinct keys by default (P2); everything else only when declared.
  const blind=cfg.explorationCatalog?.postComa?.blind===true&&(cfg.relations??[]).length===0;
  const probeMode=resolveProbeMode({override:dependencies.probeMode,declared:cfg.probeMode,blind});
  const distinctKeys=probeMode==='distinct-keys';
  if(dependencies.probeLimit!==undefined&&(!Number.isInteger(probeLimit)||probeLimit<1||probeLimit>100))throw new SafeError('PROBE_LIMIT_OUT_OF_RANGE');
  const result:any={utc:new Date().toISOString(),live:(dependencies.executionMode??'LIVE')==='LIVE',probes:[]};
  // P2: one dispersed-key read per distinct source column (budgeted by the client); a failure leaves that column on the first-rows sample and is reported.
  if(distinctKeys&&dependencies.dispersedSeeds!==false&&selectedRelations.length){const sampling=await ensureDispersedSeeds(z,{cfg,discovery:inventory,targets:seedTargetsOf(selectedRelations),scope:id});result.sampling={queries:sampling.queries,estimatedQueries:estimateSeedQueries(selectedRelations),failures:sampling.failures};}
  for(const relation of selectedRelations) {
    const a=inventory.tables[relation.from.table],b=inventory.tables[relation.to.table],mode=relation.normalization as NormalizationMode;
    const values=distinctKeys&&dependencies.dispersedSeeds!==false?seedValues(a,relation.from.column):a.sample.rows.map((row:any[])=>row[a.columns.indexOf(relation.from.column)]).filter((value:any)=>value!==null&&value!==undefined);
    const seeds=[...new Set(values.map((value:any)=>normalizeKey(value,mode,cfg.normalizationContract)))].filter((value):value is string=>value!==null);
    const variants=mode==='integer-pad10'?[...values,...seeds,...seeds.map(value=>String(value).padStart(10,'0'))]:values;
    const filterValues=[...new Set(variants)].slice(0,distinctKeys?Math.min(probeLimit,50)-1:Math.min(probeLimit,50)) as (string|number|boolean)[];
    const contractVersion=manifest.version.split('.').slice(0,2).join('.');
    const additionalColumns=Object.fromEntries([relation.from,relation.to].map(endpoint=>{
      const spec=cfg.tables[endpoint.table];return [`${endpoint.db}.${endpoint.table}`,spec.labels??[]];
    }));
    const filters=filterValues.length?Object.fromEntries([relation.from,relation.to].map(endpoint=>[
      `${endpoint.db}.${endpoint.table}`,{column:endpoint.column,values:filterValues}
    ])):{};
    const basePlan=planLegacyProbe(relation,id,contractVersion,mode,relation.minDistinctKeys??thresholds.minDistinctKeys,allowlist,probeLimit,additionalColumns,filters,probeLimit>50?probeLimit:50);
    const plan=distinctKeys&&filterValues.length?withDistinctKeysSource(basePlan):basePlan;
    const currentAt=dependencies.now?.()??new Date().toISOString();
    const execution=await executeProbe(plan,new ZetarisProbeAdapter(tableSpecs,z,probeLimit>50?probeLimit:undefined),{
      runId:`${id}:${relation.id}:${currentAt}`,checkedAt:currentAt,scope:distinctKeys&&filterValues.length?distinctKeysScope(filterValues.length):'allowlisted bounded key lookup',maxLimit:probeLimit>50?probeLimit:undefined,executionMode:dependencies.executionMode??'LIVE',dataOrigin:dependencies.dataOrigin??manifest.source.dataOrigin
    });
    const readsBySource=new Map(execution.reads.map(read=>[read.sourceId,read]));
    const endpointReads=[relation.from,relation.to].map(endpoint=>readsBySource.get(`${endpoint.db}:${endpoint.table}:${endpoint===relation.from?'from':'to'}`));
    const queries=execution.reads.map(read=>({sql:read.statement??'',requestId:read.requestId??'',queryId:read.queryId??'',rows:read.tuples,durationMs:read.durationMs??0,utc:read.requestedAt??currentAt}));
    const fromRows=endpointReads[0]?.tuples??[],toRows=endpointReads[1]?.tuples??[];
    // Distinct-keys mode reads no source rows, so source multiplicity and many-to-many come from the discovery sample rows and are labelled as such.
    const multiplicityFromRows=distinctKeys&&filterValues.length?a.sample.rows.map((row:any[])=>[row[a.columns.indexOf(relation.from.column)]]):fromRows;
    const fromMultiplicity=measureMultiplicity(multiplicityFromRows,0,mode),toMultiplicity=measureMultiplicity(toRows,0,mode);
    const rowPairs=sharedRowPairs(multiplicityFromRows,0,toRows,0,mode);
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
      multiplicity:{from:fromMultiplicity,to:toMultiplicity,sharedRowPairs:rowPairs.sharedRowPairs,pairCounts:rowPairs.pairCounts,manyToManyKeys:rowPairs.manyToManyKeys,bounded:{from:fromRows.length>=plan.limit,to:toRows.length>=plan.limit},...(distinctKeys&&filterValues.length?{sourceMultiplicity:'DISCOVERY_SAMPLE_NOT_MEASURED_IN_READ'}:{})},
      // E-02 containment, E-03 key rules and E-16 key contract: evidence next to the bounded reads, as in probe(); the decision above is computed without them.
      containment:measureContainment(multiplicityFromRows as any[][],0,toRows as any[][],0,mode,{targetFilteredBySource:filterValues.length>0}),
      keyRules:evaluateKeyRules(multiplicityFromRows,toRows,mode,{targetBounded:toRows.length>=plan.limit}),
      ...((cfg.tables[relation.from.table]?.keyContract?.[relation.from.column]||cfg.tables[relation.to.table]?.keyContract?.[relation.to.column])?{keyContracts:{from:checkKeyContract(relation.from.column,cfg.tables[relation.from.table]?.keyContract?.[relation.from.column],fromMultiplicity),to:checkKeyContract(relation.to.column,cfg.tables[relation.to.table]?.keyContract?.[relation.to.column],toMultiplicity)}}:{}),
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
    // P3: global coverage and target uniqueness measured by aggregate queries and attached to the bundle BEFORE the decision reads it; anything not measured keeps its caveat.
    if(dependencies.fullEvidence===true){
      const endpointOf=(side:'from'|'to')=>({table:relation[side].table,column:relation[side].column,type:(side==='from'?a:b).schema.find((column:any)=>column.name===relation[side].column)?.type,spec:tableSpecs[relation[side].table],sourceId:contract[side].sourceId});
      const fullEvidence=await measureFullEvidence({client:z,relationId:relation.id,from:endpointOf('from'),to:endpointOf('to'),checkedAt:currentAt,...(dependencies.profileCache?{cache:dependencies.profileCache}:{}),...(dependencies.extendedProfile===true?{extendedProfile:true}:{})});
      attachFullEvidence(execution.bundle,fullEvidence,{from:endpointOf('from'),to:endpointOf('to')});
      probe.fullEvidence=fullEvidence;
    }
    const decision=evaluateRelation(contract,[execution.bundle],relationPolicy);
    if(distinctKeys)probe.sampling=a.dispersedKeySeeds?.[relation.from.column]?(({method,poolSize,poolExhausted,requestId,queryId,seed})=>({method,poolSize,poolExhausted,requestId,queryId,seed}))(a.dispersedKeySeeds[relation.from.column]):{method:'FIRST_ROWS'};
    probe.decision=decision;probe.relationContract=contract;probe.typedEvidence=execution.bundle;
    // The review authorization (approver, date, quote) is frozen with the contract as it is now; later edits to the config do not reach this probe.
    if(relation.reviewAuthorization!==undefined)probe.reviewAuthorization=JSON.parse(JSON.stringify(relation.reviewAuthorization));
    const complete=execution.status==='COMPLETE';
    const attempt=dependencies.persist===false&&!dependencies.recordFreshness?null:recordFreshnessAttempt({universeId:manifest.manifestId,relationId:relation.id,contract,evidence:execution.bundle,decision,policy:relationPolicy,reads:execution.reads,errors:execution.errors,sourceSchemaFingerprints:[sourceSchemaFingerprintFromDescription(`${relation.from.db}:${relation.from.table}:from`,`${relation.from.db}.${relation.from.table}`,a.sourceMetadata?.rows,'LEGACY_DESCRIBE_CAPTURE',a.sourceMetadata?.utc),sourceSchemaFingerprintFromDescription(`${relation.to.db}:${relation.to.table}:to`,`${relation.to.db}.${relation.to.table}`,b.sourceMetadata?.rows,'LEGACY_DESCRIBE_CAPTURE',b.sourceMetadata?.utc)],checkedAt:currentAt});
    probe.freshness=attempt?{state:attempt.comparison,requiresReview:attempt.validity.requiresReview||attempt.comparison==='CHANGED_REQUIRES_REVIEW',preserveHistorical:true,supersedePrevious:false,reusedAsFresh:false,observedAt:attempt.validity.observedAt,checkedAt:attempt.validity.checkedAt,attemptRef:attempt.attemptId,lastCompleteAttemptRef:attempt.latestCompleteAttemptRef,sourceToken:attempt.validity.sourceToken,sourceFingerprint:attempt.validity.sourceFingerprint,fingerprintScope:attempt.fingerprintScope,scopeDescription:attempt.scopeDescription}:{state:complete?'FIRST_CHECK':'INCOMPLETA',requiresReview:!complete,preserveHistorical:true,supersedePrevious:false,reusedAsFresh:false,observedAt:null,checkedAt:currentAt};
    result.probes.push(probe);if(dependencies.persist!==false)writeJson(`out/${id}/probes.json`,result);
  }
  const output:any={utc:new Date().toISOString(),pending_llm:false,explanationSource:'deterministic-template',...(result.sampling?{sampling:result.sampling}:{}),relations:result.probes.map((probe:any)=>{
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
