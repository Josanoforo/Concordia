import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, ROOT } from './runtime.ts';
import type { RelationContract, Unknown } from './contracts/types.ts';
import type { UniverseManifest } from './registry/universes.ts';
import { resolveUniverseManifest, universeManifests, validateUniverseRegistry } from './registry/universes.ts';
import { validateRelationContract, validateUnknown } from './contracts/validate.ts';
import { evaluateRelation } from './relations/decision.ts';
import { relationPolicyFromConfig } from './relations/policy.ts';
import { recordFreshnessAttempt, type SourceSchemaFingerprint } from './reconcile/freshness-history.ts';
import { executeProbe, planProbe, type ProbeAdapter, type ProbeReadRequest, type ProbeReadResult } from './relations/probes.ts';

type SnapshotTable = { tableId:string; sourceId:string; objectId:string; dataPath:string; sha256:string; csvPath:string; csvSha256:string; columns:string[]; types:string[]; rowCount:number; rowLimit:number; dataOrigin:'SYNTHETIC'|'PUBLIC'|'USER'|'UNKNOWN'; proposedPrimaryKey:string[] };
export type Svp1Candidate = { candidateId:string; task:string; from:{universe:string;table:string;orderedColumns:string[]}; to:{universe:string;table:string;orderedColumns:string[]}; proposedBy:string; identifierSpace?:Unknown<string>; relationContractRef?:string; baseRelationContractRef?:string; inputVariant?:Record<string,unknown> };
type Candidate = Svp1Candidate;
export type Svp1Profile = { manifestId:string; version:string; alias:string; sourcePackage:'SVP1'; sourceCommit:string; snapshotRoot:string; registrySourceId:string; namespace:string; dataOrigin:SnapshotTable['dataOrigin']; availability:string; license:string; bounds:{maxRows:number;probeLimit:number;maxKeyColumns:number}; tables:SnapshotTable[]; relations:RelationContract[]; candidates:Candidate[] };
const sha256=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Pure structural validation. It does not read snapshot files. Malformed nested input returns issues, never TypeErrors. */
export function validateSvp1Profiles(input:unknown){
  const issues:{path:string;code:string}[]=[],ids=new Set<string>(),aliases=new Set<string>(),namespaces=new Set<string>();
  if(!Array.isArray(input))return [{path:'profiles',code:'EXPECTED_PROFILE_ARRAY'}];
  input.forEach((raw:any,i:number)=>{
    const at=`profiles[${i}]`;
    try{
      if(!raw||typeof raw!=='object'||Array.isArray(raw)){issues.push({path:at,code:'EXPECTED_PROFILE_OBJECT'});return;}
      const p=raw;
      if(typeof p.manifestId!=='string'||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(p.manifestId)||ids.has(p.manifestId.toLowerCase()))issues.push({path:`${at}.manifestId`,code:'INVALID_OR_DUPLICATE_MANIFEST_ID'});ids.add(String(p.manifestId).toLowerCase());
      if(typeof p.version!=='string'||!/^\d+\.\d+\.\d+$/.test(p.version))issues.push({path:`${at}.version`,code:'INVALID_PROFILE_VERSION'});
      if(typeof p.alias!=='string'||!/^\w+$/.test(p.alias)||aliases.has(p.alias.toLowerCase()))issues.push({path:`${at}.alias`,code:'INVALID_OR_DUPLICATE_ALIAS'});aliases.add(String(p.alias).toLowerCase());
      if(typeof p.sourceCommit!=='string'||! /^[a-f0-9]{40}$/.test(p.sourceCommit))issues.push({path:`${at}.sourceCommit`,code:'INVALID_SOURCE_COMMIT'});
      if(p.sourcePackage!=='SVP1'||typeof p.availability!=='string'||typeof p.license!=='string'||!p.license)issues.push({path:at,code:'INVALID_SOURCE_METADATA'});
      if(typeof p.snapshotRoot!=='string'||!/^data\/snapshots\/[A-Za-z0-9._-]+$/.test(p.snapshotRoot)||typeof p.registrySourceId!=='string'||!p.registrySourceId)issues.push({path:at,code:'INVALID_SNAPSHOT_ROOT_OR_REGISTRY_SOURCE'});
      if(typeof p.namespace!=='string'||!p.namespace||namespaces.has(p.namespace.toLowerCase()))issues.push({path:`${at}.namespace`,code:'INVALID_OR_DUPLICATE_NAMESPACE'});namespaces.add(String(p.namespace).toLowerCase());
      const bounds=p.bounds;
      if(!bounds||typeof bounds!=='object'||!Number.isInteger(bounds.maxRows)||bounds.maxRows<1||bounds.maxRows>20||!Number.isInteger(bounds.probeLimit)||bounds.probeLimit<1||bounds.probeLimit>50||!Number.isInteger(bounds.maxKeyColumns)||bounds.maxKeyColumns<1||bounds.maxKeyColumns>1)issues.push({path:`${at}.bounds`,code:'INVALID_CAPABILITY_BOUNDS'});
      const tables=p.tables;
      if(!Array.isArray(tables)||!tables.length){issues.push({path:`${at}.tables`,code:'TABLES_REQUIRED'});return;}
      const sources=new Set<string>(),objects=new Set<string>(),tableIds=new Set<string>();
      for(const [j,t] of tables.entries()){
        const tp=`${at}.tables[${j}]`,prefix=`${p.snapshotRoot}/runtime/`;
        if(!t||typeof t!=='object'||Array.isArray(t)){issues.push({path:tp,code:'EXPECTED_TABLE_OBJECT'});continue;}
        const validRelative=(v:unknown,ext:string)=>typeof v==='string'&&v.startsWith(prefix)&&new RegExp(`^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+\\.${ext}$`).test(v.slice(prefix.length));
        if(typeof t.tableId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t.tableId)||tableIds.has(t.tableId))issues.push({path:`${tp}.tableId`,code:'INVALID_OR_DUPLICATE_TABLE_ID'});tableIds.add(String(t.tableId));
        if(!validRelative(t.dataPath,'json')||!validRelative(t.csvPath,'csv'))issues.push({path:tp,code:'SNAPSHOT_PATH_OUTSIDE_APPROVED_ROOT'});
        if(!sha256(t.sha256)||!sha256(t.csvSha256))issues.push({path:tp,code:'INVALID_CONTENT_HASH'});
        if(typeof t.sourceId!=='string'||!t.sourceId||sources.has(t.sourceId)||typeof t.objectId!=='string'||!t.objectId||objects.has(t.objectId))issues.push({path:tp,code:'DUPLICATE_OR_INVALID_SOURCE_OBJECT_ID'});sources.add(String(t.sourceId));objects.add(String(t.objectId));
        if(!Array.isArray(t.columns)||!t.columns.length||t.columns.some((x:unknown)=>typeof x!=='string')||!Array.isArray(t.types)||t.columns.length!==t.types.length||t.types.some((type:unknown)=>type!=='integer'&&type!=='string'))issues.push({path:tp,code:'INVALID_COLUMN_TYPES'});
        if(!Number.isInteger(t.rowCount)||!Number.isInteger(t.rowLimit)||t.rowCount<0||t.rowCount>t.rowLimit||t.rowLimit>(bounds?.maxRows??0))issues.push({path:tp,code:'ROW_BOUND_EXCEEDED'});
        if(!Array.isArray(t.proposedPrimaryKey)||!t.proposedPrimaryKey.length||t.proposedPrimaryKey.some((key:unknown)=>typeof key!=='string'||!Array.isArray(t.columns)||!t.columns.includes(key)))issues.push({path:tp,code:'INVALID_PROPOSED_KEY'});
        if(!['SYNTHETIC','PUBLIC','USER','UNKNOWN'].includes(t.dataOrigin))issues.push({path:tp,code:'INVALID_DATA_ORIGIN'});
      }
      if(!Array.isArray(p.relations)||!Array.isArray(p.candidates)){issues.push({path:at,code:'RELATIONS_OR_CANDIDATES_REQUIRED'});return;}
      const relationIds=new Set<string>();
      for(const [j,r] of p.relations.entries()){
        const rp=`${at}.relations[${j}]`;
        if(!r||typeof r!=='object'||Array.isArray(r)){issues.push({path:rp,code:'EXPECTED_RELATION_OBJECT'});continue;}
        if(typeof r.id!=='string'||relationIds.has(r.id))issues.push({path:rp,code:'DUPLICATE_RELATION_ID'});relationIds.add(String(r.id));
        try{issues.push(...validateRelationContract(r).map((issue:{path:string;code:string})=>({path:`${rp}.${issue.path}`,code:issue.code})));}catch{issues.push({path:rp,code:'MALFORMED_RELATION_CONTRACT'});}
        for(const side of ['from','to'] as const){const endpoint=r[side];
          if(!endpoint||typeof endpoint!=='object'||Array.isArray(endpoint)||!Array.isArray(endpoint.orderedColumns)){issues.push({path:`${rp}.${side}`,code:'INVALID_RELATION_ENDPOINT'});continue;}
          const table=tables.find((item:any)=>item?.sourceId===endpoint.sourceId&&item?.objectId===endpoint.objectId);
          if(!table||endpoint.orderedColumns.length>(bounds?.maxKeyColumns??0)||endpoint.orderedColumns.some((column:unknown)=>typeof column!=='string'||!table.columns?.includes(column)))issues.push({path:rp,code:'RELATION_ENDPOINT_OUTSIDE_SNAPSHOT_ALLOWLIST'});
        }
      }
      const candidateIds=new Set<string>();
      for(const [j,c] of p.candidates.entries()){
        const cp=`${at}.candidates[${j}]`;
        if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.candidateId!=='string'||candidateIds.has(c.candidateId)||!c.from||!c.to||!Array.isArray(c.from.orderedColumns)||!Array.isArray(c.to.orderedColumns)){issues.push({path:cp,code:'INVALID_CANDIDATE'});continue;}candidateIds.add(c.candidateId);
        if(typeof c.task!=='string'||typeof c.proposedBy!=='string')issues.push({path:cp,code:'INVALID_CANDIDATE_METADATA'});
        if(c.identifierSpace!==undefined)issues.push(...validateUnknown(c.identifierSpace,`${cp}.identifierSpace`,'string'));
        for(const side of ['from','to'] as const){const endpoint=c[side],table=tables.find((item:any)=>item?.tableId===endpoint?.table);if(!table||endpoint.orderedColumns.some((column:unknown)=>typeof column!=='string'||!table.columns?.includes(column)))issues.push({path:`${cp}.${side}`,code:'CANDIDATE_ENDPOINT_OUTSIDE_SNAPSHOT_ALLOWLIST'});}
        if(c.relationContractRef!==undefined&&(typeof c.relationContractRef!=='string'||!relationIds.has(c.relationContractRef)))issues.push({path:`${cp}.relationContractRef`,code:'UNKNOWN_RELATION_CONTRACT_REF'});
        if(c.inputVariant!==undefined&&(!c.inputVariant||typeof c.inputVariant!=='object'||Array.isArray(c.inputVariant)||!Array.isArray(c.inputVariant.omittedFields)||c.inputVariant.omittedFields.some((field:unknown)=>typeof field!=='string')))issues.push({path:`${cp}.inputVariant`,code:'INVALID_INPUT_VARIANT'});
        if(c.baseRelationContractRef!==undefined){
          const base=p.relations.find((relation:any)=>relation?.id===c.baseRelationContractRef&&relation?.kind==='FOREIGN_KEY');
          const from=tables.find((table:any)=>table?.tableId===c.from.table),to=tables.find((table:any)=>table?.tableId===c.to.table);
          if(!base||!from||!to||!base.from?.orderedColumns||!base.to?.orderedColumns||base.from.sourceId!==from.sourceId||base.to.sourceId!==to.sourceId||base.from.orderedColumns.join(',')!==c.from.orderedColumns.join(',')||base.to.orderedColumns.join(',')!==c.to.orderedColumns.join(','))issues.push({path:cp+'.baseRelationContractRef',code:'INVALID_CAUSAL_BASE_CONTRACT'});
        }
      }
    }catch{issues.push({path:at,code:'MALFORMED_PROFILE_STRUCTURE'});}
  });
  return issues;
}
export function loadSvp1Profiles(configPath='universes/svp1-snapshots.json'):Svp1Profile[]{
  return readSvp1ProfilesFromConfig(configPath);
}
function readSvp1ProfilesFromConfig(configPath:string):Svp1Profile[]{
  if(typeof configPath!=='string'||!/^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(configPath))throw new Error('SVP1_CONFIG_PATH_INVALID');
  const file=path.resolve(ROOT,configPath),rel=path.relative(ROOT,file);if(rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('SVP1_CONFIG_PATH_INVALID');
  let current=ROOT;for(const part of configPath.split('/')){current=path.join(current,part);const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw new Error('SVP1_CONFIG_PATH_UNSAFE');}
  if(!fs.statSync(file).isFile())throw new Error('SVP1_CONFIG_PATH_UNSAFE');
  const real=fs.realpathSync(file),realRel=path.relative(fs.realpathSync(ROOT),real);if(realRel.startsWith('..'+path.sep)||path.isAbsolute(realRel))throw new Error('SVP1_CONFIG_PATH_UNSAFE');
  const parsed=JSON.parse(fs.readFileSync(real,'utf8'));if(!Array.isArray(parsed))throw new Error('SVP1_CONFIG_INVALID');return parsed;
}
export function validateSvp1Manifest(input:UniverseManifest,profiles?:readonly Svp1Profile[]){
  const issues:{path:string;code:string}[]=[];
  if(!input||typeof input!=='object'||Array.isArray(input))return [{path:'manifest',code:'EXPECTED_MANIFEST_OBJECT'}];
  const manifest=input as UniverseManifest;
  if(manifest.source?.adapterId!=='local-snapshot'||!manifest.capabilities?.includes('LOCAL_EVALUATION')||!manifest.capabilities?.includes('RELATION_EVALUATION'))return [{path:'manifest',code:'SNAPSHOT_CAPABILITY_REQUIRED'}];
  if(typeof manifest.source.configPath!=='string'||!/^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(manifest.source.configPath))return [{path:'manifest.source.configPath',code:'INVALID_SNAPSHOT_CONFIG_PATH'}];
  let config:Svp1Profile[];
  try{config=profiles?[...profiles]:readSvp1ProfilesFromConfig(manifest.source.configPath??'');}catch{return [{path:'manifest.source.configPath',code:'SNAPSHOT_CONFIG_UNREADABLE'}];}
  const profileIssues=validateSvp1Profiles(config);issues.push(...profileIssues);
  if(profileIssues.length)return issues;
  const profile=config.find(item=>item?.manifestId===manifest.manifestId);
  if(!profile)return [...issues,{path:'manifest.manifestId',code:'SNAPSHOT_PROFILE_NOT_FOUND'}];
  const at=`manifests.${manifest.manifestId}`;
  if(manifest.version!==profile.version)issues.push({path:`${at}.version`,code:'SNAPSHOT_VERSION_MISMATCH'});
  if(!Array.isArray(manifest.aliases)||!manifest.aliases.includes(profile.alias))issues.push({path:`${at}.aliases`,code:'SNAPSHOT_ALIAS_MISMATCH'});
  if(manifest.source.sourceId!==profile.registrySourceId||manifest.source.dataOrigin!==profile.dataOrigin)issues.push({path:`${at}.source`,code:'SNAPSHOT_SOURCE_MISMATCH'});
  const expectedCapabilities=['LOCAL_EVALUATION','RELATION_EVALUATION'].sort(),actualCapabilities=Array.isArray(manifest.capabilities)?[...manifest.capabilities].sort():[];
  if(JSON.stringify(expectedCapabilities)!==JSON.stringify(actualCapabilities))issues.push({path:`${at}.capabilities`,code:'SNAPSHOT_CAPABILITIES_MISMATCH'});
  const expectedRelations=profile.relations.map(item=>item.id).sort(),actualRelations=Array.isArray(manifest.relationIds)?[...manifest.relationIds].sort():[];
  if(JSON.stringify(expectedRelations)!==JSON.stringify(actualRelations))issues.push({path:`${at}.relationIds`,code:'SNAPSHOT_RELATIONS_MISMATCH'});
  const bounds=manifest.capabilityBounds?.LOCAL_EVALUATION;
  if(!bounds||bounds.sampleLimit!==profile.bounds.maxRows||bounds.probeLimit!==profile.bounds.probeLimit||bounds.maxKeyColumns!==profile.bounds.maxKeyColumns||bounds.maxRelationsPerRun!==profile.relations.length)issues.push({path:`${at}.capabilityBounds.LOCAL_EVALUATION`,code:'SNAPSHOT_BOUNDS_MISMATCH'});
  if(profile.relations.some(relation=>relation.universeRef?.universeId!==manifest.manifestId))issues.push({path:`${at}.relations`,code:'SNAPSHOT_RELATION_UNIVERSE_MISMATCH'});
  return issues;
}
export function resolveSvp1Profile(idOrAlias:string,profiles?:readonly Svp1Profile[],manifests:readonly UniverseManifest[]=universeManifests){
  const manifest=resolveUniverseManifest(idOrAlias,[...manifests]);if(!manifest||manifest.source?.adapterId!=='local-snapshot'||!manifest.capabilities?.includes('LOCAL_EVALUATION')||!manifest.capabilities?.includes('RELATION_EVALUATION'))return undefined;
  let source:Svp1Profile[];try{source=profiles?[...profiles]:readSvp1ProfilesFromConfig(manifest.source.configPath??'');}catch{return undefined;}
  return source.find(profile=>profile?.manifestId===manifest.manifestId&&manifest.aliases.includes(profile.alias));
}

function safeFile(relative:string,snapshotRoot:string){
  const base=path.resolve(ROOT,snapshotRoot,'runtime'),file=path.resolve(ROOT,relative),rel=path.relative(base,file);
  if(!rel||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('SNAPSHOT_PATH_OUTSIDE_APPROVED_ROOT');
  let current=ROOT;for(const part of relative.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('SNAPSHOT_PATH_REPARSE_POINT');}
  const real=fs.realpathSync(file),realRel=path.relative(fs.realpathSync(base),real);
  if(!realRel||realRel.startsWith(`..${path.sep}`)||path.isAbsolute(realRel))throw new Error('SNAPSHOT_PATH_OUTSIDE_APPROVED_ROOT');return real;
}
function loadRows(p:Svp1Profile){
  const result=new Map<string,readonly unknown[][]>();
  for(const t of p.tables){
    const data=fs.readFileSync(safeFile(t.dataPath,p.snapshotRoot)),csv=fs.readFileSync(safeFile(t.csvPath,p.snapshotRoot));
    if(createHash('sha256').update(data).digest('hex')!==t.sha256||createHash('sha256').update(csv).digest('hex')!==t.csvSha256)throw new Error(`SNAPSHOT_HASH_MISMATCH:${t.tableId}`);
    const document=JSON.parse(data.toString('utf8'));
    if(!document||typeof document!=='object'||!Array.isArray(document.rows)||!Array.isArray(document.columns)||!Array.isArray(document.types))throw new Error(`SNAPSHOT_ROW_BOUND_OR_SHAPE:${t.tableId}`);
    if(JSON.stringify(document.columns)!==JSON.stringify(t.columns)||JSON.stringify(document.types)!==JSON.stringify(t.types)||document.rows.length!==t.rowCount||document.rows.length>t.rowLimit)throw new Error(`SNAPSHOT_ROW_BOUND_OR_SHAPE:${t.tableId}`);
    const rows=document.rows.map((row:unknown)=>{if(!Array.isArray(row)||row.length!==t.columns.length)throw new Error(`SNAPSHOT_ROW_SHAPE:${t.tableId}`);return row.map((value:unknown,index:number)=>{if(t.types[index]==='string'&&typeof value!=='string'||t.types[index]==='integer'&&(typeof value!=='number'||!Number.isSafeInteger(value)))throw new Error(`SNAPSHOT_TYPE:${t.tableId}.${t.columns[index]}`);return value;});});
    result.set(`${t.sourceId}:${t.objectId}`,rows);
  }return result;
}
/** Load and validate the selected profile's pinned snapshot rows for live-binding parity checks. */
export function loadSvp1ProfileRows(profile:Svp1Profile):ReadonlyMap<string,readonly unknown[][]>{return loadRows(profile);}
class SnapshotAdapter implements ProbeAdapter{
  readonly adapterId='local-svp1-snapshot';
  constructor(private rows:ReadonlyMap<string,readonly unknown[][]>,private tables:readonly SnapshotTable[]){}
  async read(request:ProbeReadRequest):Promise<ProbeReadResult>{
    const table=this.tables.find(item=>item.sourceId===request.sourceId&&item.objectId===request.objectId);
    const rows=this.rows.get(`${request.sourceId}:${request.objectId}`);
    if(!table||!rows)throw new Error('SNAPSHOT_OBJECT_NOT_ALLOWLISTED');if(request.filter)throw new Error('SNAPSHOT_ADAPTER_FILTER_UNSUPPORTED');
    const indexes=request.columns.map(column=>table.columns.indexOf(column));
    if(indexes.some(index=>index<0))throw new Error('SNAPSHOT_COLUMN_NOT_ALLOWLISTED');
    return{tuples:rows.slice(0,request.limit).map(row=>indexes.map(index=>row[index])),requestId:`local-svp1:${table.tableId}:${request.limit}`,truncated:rows.length>request.limit};
  }
}
const notRun=(c:Candidate,reason:string,inputVariant?:Record<string,unknown>)=>({candidateId:c.candidateId,task:c.task,status:'NOT_RUN',queryStatus:'NOT_QUERIED',queryRefs:[],reason,...(inputVariant?{inputVariant}:{})});
const known=(value:string)=>({state:'KNOWN' as const,value});
const unknown=()=>({state:'UNKNOWN' as const});
export function synthesizeCandidateContract(candidate:Svp1Candidate,p:Svp1Profile):RelationContract|undefined{
  if(!['FOREIGN_KEY','IDENTITY','ASSOCIATION','SCHEMA_CORRESPONDENCE','MEASURE_EQUIVALENCE'].includes(candidate.task))return undefined;
  const fromTable=p.tables.find(item=>item.tableId===candidate.from.table),toTable=p.tables.find(item=>item.tableId===candidate.to.table);
  if(!fromTable||!toTable||candidate.from.orderedColumns.some(c=>!fromTable.columns.includes(c))||candidate.to.orderedColumns.some(c=>!toTable.columns.includes(c))||candidate.from.orderedColumns.length!==candidate.to.orderedColumns.length)return undefined;
  const normalization=candidate.from.orderedColumns.map((_,index)=>{
    const fromType=fromTable.types[fromTable.columns.indexOf(candidate.from.orderedColumns[index])],toType=toTable.types[toTable.columns.indexOf(candidate.to.orderedColumns[index])],same=fromType===toType;
    const operation=same?known(fromType==='string'?'text':'integer'):unknown();
    return{componentIndex:index,operation,version:known('svp1-native-exact-v1'),lossless:same?{state:'KNOWN' as const,value:true}:unknown(),adapterCapability:same?known(fromType==='string'?'exact-text':'native-integer'):unknown()};
  });
  return{schemaVersion:1,id:`candidate:${candidate.candidateId}`,contractVersion:'1.0',universeRef:{universeId:p.manifestId,universeVersion:known(p.version),namespace:known(p.namespace),configFingerprint:unknown()},kind:candidate.task as RelationContract['kind'],
    from:{sourceId:fromTable.sourceId,namespace:known(p.namespace),objectId:fromTable.objectId,orderedColumns:[...candidate.from.orderedColumns]},
    to:{sourceId:toTable.sourceId,namespace:known(p.namespace),objectId:toTable.objectId,orderedColumns:[...candidate.to.orderedColumns]},identifierSpace:candidate.identifierSpace?structuredClone(candidate.identifierSpace):unknown(),normalization,
    semanticContext:{grain:unknown(),unit:unknown(),scale:unknown(),period:unknown(),timezone:unknown()},assertions:[],
    evidencePolicy:{requiredObservationTypes:candidate.task==='SCHEMA_CORRESPONDENCE'?['SCHEMA_CORRESPONDENCE']:['KEY_MEMBERSHIP'],minimumCompleteness:'COMPLETE_FOR_SCOPE',nulls:'REQUIRE_MEASUREMENT',cardinality:'REQUIRE_MEASUREMENT',declarationsAdmissible:false,minimumDistinctKeys:2},reviewState:'PENDING'};
}
function relationOrigin(contract:RelationContract,p:Svp1Profile):SnapshotTable['dataOrigin']{
  const a=p.tables.find(table=>table.sourceId===contract.from.sourceId&&table.objectId===contract.from.objectId)?.dataOrigin;
  const b=p.tables.find(table=>table.sourceId===contract.to.sourceId&&table.objectId===contract.to.objectId)?.dataOrigin;
  return a&&a===b?a:'UNKNOWN';
}
function candidateOrigin(candidate:Candidate,p:Svp1Profile):SnapshotTable['dataOrigin']{
  const a=p.tables.find(table=>table.tableId===candidate.from?.table)?.dataOrigin;
  const b=p.tables.find(table=>table.tableId===candidate.to?.table)?.dataOrigin;
  return a&&a===b?a:'UNKNOWN';
}
/** Shared typed probe entry point. Adapter selection and execution mode are explicit at the caller. */
export async function executeSvp1Probe(plan:ReturnType<typeof planProbe>,adapter:ProbeAdapter,context:Parameters<typeof executeProbe>[2],p:Svp1Profile){

  const execution=await executeProbe(plan,adapter,context);
  if(adapter.adapterId==='local-svp1-snapshot')for(const observation of execution.bundle.observations){const source=p.tables.find(table=>table.sourceId===observation.sourceRef);if(source){observation.nativeVersion=known(p.sourceCommit);observation.fingerprint=known(source.sha256);}}
  return execution;
}
type MethodAction='ACCEPT'|'REJECT'|'ABSTAIN'|'REVIEW'|'ERROR'|'NOT_QUERIED';
const methodAction=(decision:any,probeStatus?:string):MethodAction=>{
  if(probeStatus==='ERROR')return'ERROR';if(!decision)return'NOT_QUERIED';if(decision.requiresReview)return'REVIEW';
  if(decision.verdict==='SOSTENIDA')return'ACCEPT';if(decision.verdict==='ENGAÑOSA')return'REJECT';return'ABSTAIN';
};
function omitSemanticMetadata(contract:RelationContract):RelationContract{
  const omitted=structuredClone(contract),u=unknown();
  omitted.universeRef.namespace={...u};omitted.from.namespace={...u};omitted.to.namespace={...u};omitted.identifierSpace={...u};
  omitted.semanticContext={grain:{...u},unit:{...u},scale:{...u},period:{...u},timezone:{...u},...(omitted.semanticContext.properties?{properties:Object.fromEntries(Object.keys(omitted.semanticContext.properties).sort().map(key=>[key,{state:'UNKNOWN'}]))}:{})};
  omitted.assertions=[];omitted.id=`${contract.id}:metadata-omission`;
  return omitted;
}
function methodEnvelope(method:string,version:string,policyVersion:string,budgetId:string,dataOrigin:string,outcomes:{caseId:string;action:MethodAction}[],frozenInputHash:string,executionMode:'LOCAL'|'LIVE'='LOCAL'){
  return{method,version,productCommit:null as string|null,policyVersion,budgetId,frozenAtUtc:null as string|null,runtimeSha256:null as string|null,candidateSha256:null as string|null,split:executionMode==='LIVE'?'LIVE_OPERATIONAL_SAMPLE':'KNOWN_EVALUATION_RESERVE',executionMode,dataOrigin,outcomes,frozenInputHash,adaptedConfigSha256:null as string|null,freezeStatus:'PENDING_ROOT_FREEZE' as const};
}
function applyInputVariant<T extends Record<string,any>>(base:T,variant:Record<string,unknown>):T{
  const result=structuredClone(base),fields=Array.isArray(variant.omittedFields)?variant.omittedFields:[];
  for(const rawField of fields){if(typeof rawField!=='string')continue;const replacement=variant[rawField];if(replacement&&typeof replacement==='object'&&'state'in replacement)(result as any)[rawField]=structuredClone(replacement);else delete (result as any)[rawField];}
  return result;
}

/** Offline bounded evaluation through the shared typed planner and evaluator. */
export async function evaluateSvp1Snapshot(idOrAlias:string,options:{runId?:string;policyVersion?:string;now?:()=>string;adapter?:ProbeAdapter;executionMode?:'LOCAL'|'REPLAY'|'LIVE';routeManifest?:UniverseManifest;profileManifestId?:string;profileConfigPath?:string;bindingId?:string;scope?:string;relationIds?:readonly string[];persistFreshness?:boolean;sourceSchemaFingerprints?:readonly SourceSchemaFingerprint[]}={}){
  const manifest=options.routeManifest??resolveUniverseManifest(idOrAlias);if(!manifest)throw new Error('SVP1_PROFILE_NOT_REGISTERED');
  const profileConfigPath=options.profileConfigPath??manifest.source.configPath??'';
  const profiles=readSvp1ProfilesFromConfig(profileConfigPath);
  const profileManifestId=options.profileManifestId??manifest.manifestId;
  const p0=options.adapter?profiles.find(profile=>profile.manifestId===profileManifestId):resolveSvp1Profile(idOrAlias,profiles);
  if(!p0||p0.manifestId!==profileManifestId)throw new Error('SVP1_PROFILE_NOT_FOUND');
  if(options.adapter){const profileIssues=validateSvp1Profiles(profiles);if(profileIssues.length)throw new TypeError(profileIssues.map(x=>x.path+':'+x.code).join(', '));}
  else{const manifestIssues=validateSvp1Manifest(manifest,profiles);if(manifestIssues.length)throw new TypeError(manifestIssues.map(x=>x.path+':'+x.code).join(', '));}
  const p=structuredClone(p0),frozenRelations=structuredClone(p.relations),frozenCandidates=structuredClone(p.candidates);
  const configRelative=options.adapter?manifest.source.configPath:profileConfigPath;
  if(!configRelative)throw new Error('SVP1_CONFIG_PATH_REQUIRED');
  const configFile=path.resolve(ROOT,configRelative),adaptedConfigSha256=createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
  const rows=options.adapter?undefined:loadRows(p),thresholds=readJson<any>('config/thresholds.json'),policy=relationPolicyFromConfig({...thresholds,...(options.policyVersion?{relationPolicyVersion:options.policyVersion}:{})}),allowlist=Object.fromEntries(p.tables.map(t=>[t.objectId,t.columns])),adapter=options.adapter??new SnapshotAdapter(rows!,p.tables),executionMode=options.executionMode??'LOCAL';
  if(executionMode==='LIVE'&&!options.adapter)throw new Error('SVP1_LIVE_ADAPTER_REQUIRED');
  const runId=options.runId??(options.routeManifest?'svp1-live:'+manifest.manifestId+':'+manifest.version+':'+randomUUID():'svp1:'+p.manifestId+':'+p.version+':'+randomUUID());
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(runId))throw new Error('INVALID_SVP1_RUN_ID');
  const frozenInputHash=createHash('sha256').update(JSON.stringify({manifestId:p.manifestId,version:p.version,sourceCommit:p.sourceCommit,policyVersion:policy.policyVersion,bounds:p.bounds,contracts:frozenRelations,candidates:frozenCandidates,tableHashes:p.tables.map(t=>({tableId:t.tableId,sha256:t.sha256,csvSha256:t.csvSha256})),...(options.adapter?{bindingId:options.bindingId??null,bindingConfigSha256:adaptedConfigSha256}:{})})).digest('hex');
  const decisions:any[]=[],predictions:any[]=[],evidenceByContractRef=new Map<string,{bundle:any;reads:any[];status:string}>();
  const selectedCandidates=options.relationIds?frozenCandidates.filter(candidate=>options.relationIds!.includes(candidate.candidateId)||options.relationIds!.includes(candidate.relationContractRef??'')):frozenCandidates;
  if(options.relationIds&&selectedCandidates.length!==new Set(options.relationIds).size)throw new Error('SVP1_CANDIDATE_NOT_FOUND');
  for(const candidate of selectedCandidates){
    if(candidate.task==='UNIQUE_KEY'){predictions.push({...notRun(candidate,'unsupported_relation_kind_unique_key'),dataOrigin:candidateOrigin(candidate,p)});continue;}
    if(candidate.inputVariant){
      const baseRef=(candidate as any).baseRelationContractRef;
      const baseContract=p.relations.find(item=>item.id===baseRef&&item.kind==='FOREIGN_KEY');
      if(!baseContract){predictions.push({candidateId:candidate.candidateId,task:'METADATA_OMISSION_CONTROL',sourceTask:candidate.task,controlRole:'CAUSAL_INPUT_ABLATION',truthStatus:'NOT_SCORED',status:'NOT_EVALUABLE',queryStatus:'NOT_QUERIED',queryRefs:[],reason:'matching_foreign_key_base_contract_missing'});continue;}
      let base=evidenceByContractRef.get(baseContract.id);
      if(!base){
        const plan=planProbe(baseContract,allowlist,Math.min(p.bounds.probeLimit,50),50),checkedAt=options.now?.()??new Date().toISOString();
        if(Number.isNaN(Date.parse(checkedAt)))throw new Error('INVALID_SVP1_CHECKED_AT');
        const execution=await executeSvp1Probe(plan,adapter,{runId,checkedAt,scope:options.scope??('SVP1 bounded probe; max '+p.bounds.maxRows+' rows/table'),executionMode,dataOrigin:relationOrigin(baseContract,p)},p);
        base={bundle:execution.bundle,reads:execution.reads,status:execution.status};evidenceByContractRef.set(baseContract.id,base);
      }
      const contract=applyInputVariant(baseContract,candidate.inputVariant);
      contract.id=`${baseContract.id}:ablation:${candidate.candidateId}`;
      const evidence=structuredClone(base.bundle);evidence.relationRef=contract.id;evidence.evidenceBundleId=`${base.bundle.evidenceBundleId}:ablation:${candidate.candidateId}`;
      evidence.observations=evidence.observations.map((observation:any,index:number)=>({...observation,observationId:`${evidence.evidenceBundleId}:${index}`}));
      const baselineDecision=evaluateRelation(baseContract,[base.bundle],policy),decision=evaluateRelation(contract,[evidence],policy);
      const evidenceRef=evidence.evidenceBundleId,queryRefs=base.reads.map((read:any)=>read.requestId).filter(Boolean);
      decisions.push({candidateId:candidate.candidateId,task:'METADATA_OMISSION_CONTROL',relationContractRef:contract.id,contractVersion:contract.contractVersion,contract,evidenceRef,evidenceBundle:evidence,probeStatus:base.status,decision,baselineDecision});
      predictions.push({candidateId:candidate.candidateId,task:'METADATA_OMISSION_CONTROL',sourceTask:candidate.task,controlRole:'CAUSAL_INPUT_ABLATION',truthStatus:'NOT_SCORED',dataOrigin:base.bundle.runRef.dataOrigin,status:base.status==='COMPLETE'?'EVALUATED':'INCOMPLETE',queryStatus:base.status==='COMPLETE'?'COMPLETE':base.status,queryRefs,relationContractRef:contract.id,evidenceRef,contractVersion:contract.contractVersion,verdict:decision.verdict,decisionStatus:decision.status,reasonCodes:decision.reasonCodes,inputVariantApplied:(candidate.inputVariant as any).omittedFields??[],ablationComparison:{baselineReasonCodes:baselineDecision.reasonCodes,variantReasonCodes:decision.reasonCodes,reusedBaseContractRef:baseContract.id}});
      continue;
    }
    const suppliedRef=(candidate as any).relationContractRef;
    const contract=p.relations.find(item=>item.id===suppliedRef)??synthesizeCandidateContract(candidate,p);
    if(!contract){predictions.push({...notRun(candidate,'relation_contract_context_missing'),dataOrigin:candidateOrigin(candidate,p)});continue;}
    if(validateRelationContract(contract).length){predictions.push({...notRun(candidate,'relation_contract_invalid'),dataOrigin:candidateOrigin(candidate,p)});continue;}
    let execution:any=null,decision:any;
    if(contract.kind==='SCHEMA_CORRESPONDENCE')decision=evaluateRelation(contract,[],policy);
    else{
      const plan=planProbe(contract,allowlist,Math.min(p.bounds.probeLimit,50),50),checkedAt=options.now?.()??new Date().toISOString();
      if(Number.isNaN(Date.parse(checkedAt)))throw new Error('INVALID_SVP1_CHECKED_AT');
      execution=await executeSvp1Probe(plan,adapter,{runId,checkedAt,scope:options.scope??('SVP1 bounded probe; max '+p.bounds.maxRows+' rows/table'),executionMode,dataOrigin:relationOrigin(contract,p)},p);
      evidenceByContractRef.set(contract.id,{bundle:execution.bundle,reads:execution.reads,status:execution.status});
      decision=evaluateRelation(contract,[execution.bundle],policy);
    }
    const evidenceRef=execution?.bundle.evidenceBundleId??null;
    decisions.push({candidateId:candidate.candidateId,relationContractRef:contract.id,contractVersion:contract.contractVersion,contract,evidenceRef,evidenceBundle:execution?.bundle??null,probeStatus:execution?.status??'NOT_QUERIED',decision});
    if(options.persistFreshness&&execution)recordFreshnessAttempt({universeId:options.routeManifest?.manifestId??p.manifestId,relationId:contract.id,contract,evidence:execution.bundle,decision,policy,reads:execution.reads,sourceSchemaFingerprints:options.sourceSchemaFingerprints,checkedAt:execution.bundle.observations.map((item:any)=>item.checkedAt).sort().at(-1),now:options.now});
    predictions.push({candidateId:candidate.candidateId,task:candidate.task,dataOrigin:relationOrigin(contract,p),status:execution?(execution.status==='COMPLETE'?'EVALUATED':'INCOMPLETE'):'EVALUATED',queryStatus:execution?(execution.status==='COMPLETE'?'COMPLETE':execution.status):'NOT_QUERIED',queryRefs:execution?execution.reads.map((read:any)=>read.requestId).filter(Boolean):[],relationContractRef:contract.id,evidenceRef,contractVersion:contract.contractVersion,verdict:decision.verdict,decisionStatus:decision.status,reasonCodes:decision.reasonCodes});
  }
  const causalControls=predictions.filter(item=>item.controlRole==='CAUSAL_INPUT_ABLATION');
  const candidateIds=frozenCandidates.map(item=>item.candidateId),controlIds=new Set(frozenCandidates.filter(item=>item.inputVariant).map(item=>item.candidateId));
  const decisionByCandidate=new Map(decisions.filter(item=>!item.task||item.task!=='METADATA_OMISSION_CONTROL').map(item=>[item.candidateId,item]));
  const productOutcomes=frozenCandidates.map(candidate=>{
    if(candidate.task==='UNIQUE_KEY'||controlIds.has(candidate.candidateId))return{caseId:candidate.candidateId,action:'NOT_QUERIED' as const};
    const prediction=predictions.find(item=>item.candidateId===candidate.candidateId&&!item.controlRole),decision=decisionByCandidate.get(candidate.candidateId);
    if(!decision||!prediction||prediction.status==='NOT_RUN'||prediction.status==='NOT_EVALUABLE')return{caseId:candidate.candidateId,action:'NOT_QUERIED' as const};
    return{caseId:candidate.candidateId,action:methodAction(decision.decision,decision.probeStatus)};
  });
  const ablationOutcomes=frozenCandidates.map(candidate=>{
    if(candidate.task==='UNIQUE_KEY'||controlIds.has(candidate.candidateId))return{caseId:candidate.candidateId,action:'NOT_QUERIED' as const};
    const record=decisionByCandidate.get(candidate.candidateId);if(!record)return{caseId:candidate.candidateId,action:'NOT_QUERIED' as const};
    if(record.probeStatus==='ERROR')return{caseId:candidate.candidateId,action:'ERROR' as const};
    try{
      const altered=omitSemanticMetadata(record.contract),bundles=record.evidenceBundle?[structuredClone(record.evidenceBundle)]:[];
      for(const [index,bundle] of bundles.entries()){bundle.relationRef=altered.id;bundle.evidenceBundleId=`${record.evidenceBundle.evidenceBundleId}:metadata-omission`;bundle.observations=bundle.observations.map((observation:any,observationIndex:number)=>({...observation,observationId:`${bundle.evidenceBundleId}:${observationIndex}`}));}
      const ablatedDecision=evaluateRelation(altered,bundles,policy);return{caseId:candidate.candidateId,action:methodAction(ablatedDecision,record.probeStatus)};
    }catch{return{caseId:candidate.candidateId,action:'ERROR' as const};}
  });
  const profileOrigins=[...new Set(p.tables.map(table=>table.dataOrigin))],envelopeOrigin=profileOrigins.length===1?profileOrigins[0]:'MIXED';
  const budgetId=`svp1-bounded-r${p.bounds.maxRows}-p${p.bounds.probeLimit}-k${p.bounds.maxKeyColumns}`;
  const methodVersion=String(readJson<any>('package.json').version??'unknown');
  const comparisonEnvelopes={product:{...methodEnvelope('concordia-product',methodVersion,policy.policyVersion,budgetId,envelopeOrigin,productOutcomes,frozenInputHash,executionMode==='LIVE'?'LIVE':'LOCAL'),adaptedConfigSha256},metadataOmissionAblation:{...methodEnvelope('concordia-metadata-ablation',methodVersion,policy.policyVersion,budgetId,envelopeOrigin,ablationOutcomes,frozenInputHash,executionMode==='LIVE'?'LIVE':'LOCAL'),adaptedConfigSha256}};
  return{schemaVersion:1,runId,manifestId:options.routeManifest?manifest.manifestId:p.manifestId,version:options.routeManifest?manifest.version:p.version,alias:options.routeManifest?manifest.aliases[0]:p.alias,executionMode,dataOrigin:manifest.source.dataOrigin,sourceCommit:p.sourceCommit,sourcePackage:p.sourcePackage,adaptedConfigSha256,...(executionMode==='LOCAL'?{tableHashes:p.tables.map(t=>({tableId:t.tableId,dataOrigin:t.dataOrigin,sha256:t.sha256,csvSha256:t.csvSha256}))}:{}),...(options.bindingId?{sourceBindingId:options.bindingId}:{}),frozenInputHash,candidateCount:predictions.length,decisions,predictions,causalControls,comparisonEnvelopes,evaluationMeaning:executionMode==='LIVE'?'Root-reviewed bounded LIVE probe output; no truth, global uniqueness, holdout scoring, or publication authorization.':'Offline bounded-snapshot protocol output; not truth, global uniqueness, live source acceptance, or publication authorization.'};
}
/** One serial product-method envelope for all label-free candidates. */
export async function evaluateSvp1Suite(options:{runId?:string;policyVersion?:string;now?:()=>string}={}){
  const registryIssues=validateUniverseRegistry(universeManifests);
  if(registryIssues.length)throw new TypeError(registryIssues.map(issue=>`${issue.path}:${issue.code}`).join(', '));
  const suiteRunId=options.runId??`svp1-suite:${randomUUID()}`;
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(suiteRunId))throw new Error('INVALID_SVP1_RUN_ID');
  const universes=[];
  const snapshotManifests=universeManifests.filter(manifest=>manifest.source.adapterId==='local-snapshot'&&manifest.capabilities.includes('LOCAL_EVALUATION')&&manifest.capabilities.includes('RELATION_EVALUATION'));
  for(const manifest of snapshotManifests){
    const manifestIssues=validateSvp1Manifest(manifest);
    if(manifestIssues.length)throw new TypeError(manifestIssues.map(issue=>`${issue.path}:${issue.code}`).join(', '));
    universes.push(await evaluateSvp1Snapshot(manifest.manifestId,{policyVersion:options.policyVersion,now:options.now,runId:`${suiteRunId}:${manifest.aliases[0]}`}));
  }
  const predictions=universes.flatMap(universe=>universe.predictions.map(prediction=>({...prediction,manifestId:universe.manifestId,universeVersion:universe.version,universeAlias:universe.alias})));
  const decisions=universes.flatMap(universe=>universe.decisions.map(decision=>({...decision,manifestId:universe.manifestId,universeVersion:universe.version})));
  const productOutcomes=universes.flatMap(universe=>universe.comparisonEnvelopes.product.outcomes),ablationOutcomes=universes.flatMap(universe=>universe.comparisonEnvelopes.metadataOmissionAblation.outcomes);
  const frozenInputHash=createHash('sha256').update(JSON.stringify(universes.map(universe=>universe.frozenInputHash))).digest('hex');
  const origins=[...new Set(universes.flatMap(universe=>(universe.tableHashes??[]).map((table:any)=>table.dataOrigin)))],dataOrigin=origins.length===1?origins[0]:'MIXED';
  const budgets=[...new Set(universes.map(universe=>{const profile=resolveSvp1Profile(universe.manifestId)!;return`r${profile.bounds.maxRows}-p${profile.bounds.probeLimit}-k${profile.bounds.maxKeyColumns}`;}))].sort().join('+');
  const budgetId=`svp1-suite-${createHash('sha256').update(budgets).digest('hex').slice(0,16)}`,methodVersion=String(readJson<any>('package.json').version??'unknown'),policyVersion=options.policyVersion??relationPolicyFromConfig(readJson<any>('config/thresholds.json')).policyVersion;
  const adaptedConfigSha256=createHash('sha256').update(JSON.stringify(universes.map(universe=>universe.adaptedConfigSha256))).digest('hex');
  const methodEnvelopes={product:{...methodEnvelope('concordia-product',methodVersion,policyVersion,budgetId,dataOrigin,productOutcomes,frozenInputHash),adaptedConfigSha256},metadataOmissionAblation:{...methodEnvelope('concordia-metadata-ablation',methodVersion,policyVersion,budgetId,dataOrigin,ablationOutcomes,frozenInputHash),adaptedConfigSha256}};
  return{schemaVersion:1,runId:suiteRunId,method:'concordia-common-relation-evaluator',executionMode:'LOCAL',candidateCount:predictions.length,universes:universes.map(universe=>({manifestId:universe.manifestId,version:universe.version,alias:universe.alias,sourceCommit:universe.sourceCommit,dataOrigin:universe.dataOrigin,tableHashes:universe.tableHashes})),decisions,predictions,causalControls:universes.flatMap(universe=>universe.causalControls),methodEnvelopes,freezeStatus:'PENDING_ROOT_FREEZE',evaluationMeaning:'Offline bounded-snapshot protocol output; no labels, truth, global uniqueness, live source acceptance, or publication authorization.'};
}
