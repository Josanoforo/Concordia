import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, SafeError } from '../runtime.ts';
import type { Decision, EvidenceBundle, RelationContract } from '../contracts/types.ts';
import { validateDecision, validateEvidenceBundle, validateRelationContract } from '../contracts/validate.ts';
import { evaluateRelation } from '../relations/decision.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import type { RelationPolicy } from '../relations/decision.ts';
import { acquireReconcileWriterLock, atomicWriteFile } from './persistence.ts';
import { assessEvidenceValidity, type EvidenceValidity } from './freshness.ts';
import type { ProbeExecutionResult } from '../relations/probes.ts';

export type FreshnessComparison = 'FIRST_CHECK'|'REVALIDATED'|'CHANGED_REQUIRES_REVIEW'|'INCOMPLETE';
export type SourceSchemaFingerprint = {sourceId:string;objectId:string;state:'KNOWN';sha256:string;provenance:string;observedAt?:string}|{sourceId:string;objectId:string;state:'UNKNOWN';provenance:string;observedAt?:string};
export interface FreshnessAttempt {
  schemaVersion:1; sequence:number; kind:'EVIDENCE'|'PREFLIGHT_FAILURE'; attemptId:string; universeId:string; relationId:string; relationRef:string; recordedAt:string; executionMode:'LIVE'|'LOCAL'|'REPLAY'|'UNKNOWN'; dataOrigin:string;
  comparison:FreshnessComparison; validity:EvidenceValidity; fingerprintScope:'NATIVE_VERSION_TOKEN_SHA256'|'BOUNDED_RESPONSE'|'UNKNOWN';
  scopeDescription:string; semanticSourceVersion:string; latestCompleteAttemptRef:string|null;
  contract:RelationContract; policy:RelationPolicy; schemaFingerprints:SourceSchemaFingerprint[]; evidence:EvidenceBundle|null; decision:Decision|null;
  sourceQueryHistory:{sourceId:string;requestId?:string;queryId?:string;requestedAt?:string;observedAt?:string;statement?:string}[];
  transportFailures:{sourceRef:string;code:string;http?:number;retryAfter?:string}[]; checksum:string;
}
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>!item||typeof item!=='object'||Array.isArray(item)?item:Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b,'en'))));
const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
const safeId=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const checksumBody=(record:Omit<FreshnessAttempt,'checksum'>)=>digest(record);
const isWithin=(candidate:string,root:string)=>{const rel=path.relative(path.resolve(root),path.resolve(candidate));return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
function historyDirectory(universeId:string,relationId:string,create:boolean):string{
  if(!safeId(universeId)||typeof relationId!=='string'||!relationId||relationId.length>512)throw new SafeError('FRESHNESS_SCOPE_INVALID');
  const concordia=path.resolve(ROOT,'.concordia'),root=path.join(concordia,'freshness-v2'),universe=path.join(root,universeId),relation=path.join(universe,createHash('sha256').update(relationId).digest('hex'));
  let rootStat:fs.Stats;try{rootStat=fs.lstatSync(concordia);}catch(error:any){if(error?.code!=='ENOENT'||!create){if(error?.code==='ENOENT')return relation;throw error;}fs.mkdirSync(concordia);rootStat=fs.lstatSync(concordia);}if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new SafeError('FRESHNESS_ROOT_INVALID');
  const realRoot=fs.realpathSync(concordia);
  for(const dir of [root,universe,relation]){
    if(!fs.existsSync(dir)){if(!create)return relation;fs.mkdirSync(dir);}
    const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||!isWithin(fs.realpathSync(dir),realRoot))throw new SafeError('FRESHNESS_PATH_INVALID');
  }
  return relation;
}
function validateAttempt(raw:any):FreshnessAttempt{
  if(!raw||raw.schemaVersion!==1||!Number.isSafeInteger(raw.sequence)||raw.sequence<1||!['EVIDENCE','PREFLIGHT_FAILURE'].includes(raw.kind)||!safeId(raw.universeId)||typeof raw.relationId!=='string'||!raw.relationId||typeof raw.attemptId!=='string'||!/^attempt:[a-f0-9-]{36}$/.test(raw.attemptId)||raw.relationRef!==raw.contract?.id||!['LIVE','LOCAL','REPLAY','UNKNOWN'].includes(raw.executionMode)||typeof raw.dataOrigin!=='string'||!['FIRST_CHECK','REVALIDATED','CHANGED_REQUIRES_REVIEW','INCOMPLETE'].includes(raw.comparison)||!['NATIVE_VERSION_TOKEN_SHA256','BOUNDED_RESPONSE','UNKNOWN'].includes(raw.fingerprintScope)||!Array.isArray(raw.schemaFingerprints)||!Array.isArray(raw.sourceQueryHistory)||!Array.isArray(raw.transportFailures)||!Number.isFinite(Date.parse(raw.recordedAt))||typeof raw.semanticSourceVersion!=='string'||!raw.semanticSourceVersion||!raw.validity||typeof raw.validity!=='object'||validateRelationContract(raw.contract).length)throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
  if(raw.schemaFingerprints.some((item:any)=>!item||typeof item.sourceId!=='string'||typeof item.objectId!=='string'||!['KNOWN','UNKNOWN'].includes(item.state)||typeof item.provenance!=='string'||item.state==='KNOWN'&&!/^[a-f0-9]{64}$/.test(item.sha256)||item.observedAt!==undefined&&!Number.isFinite(Date.parse(item.observedAt))))throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
  const expectedSchemaRefs=[raw.contract.from,raw.contract.to].map((endpoint:any)=>endpoint.sourceId+'\u0000'+endpoint.objectId).sort(),actualSchemaRefs=raw.schemaFingerprints.map((item:any)=>item.sourceId+'\u0000'+item.objectId).sort();
  if(raw.schemaFingerprints.length!==2||JSON.stringify(expectedSchemaRefs)!==JSON.stringify(actualSchemaRefs))throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
  if(raw.kind==='EVIDENCE'&&(!raw.evidence||!raw.decision||raw.evidence.relationRef!==raw.contract.id||raw.evidence.contractVersion!==raw.contract.contractVersion||raw.decision.relationRef!==raw.contract.id||raw.decision.contractVersion!==raw.contract.contractVersion||validateEvidenceBundle(raw.evidence).length||validateDecision(raw.decision).length))throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
  if(raw.kind==='PREFLIGHT_FAILURE'&&(raw.evidence!==null||raw.decision!==null||raw.comparison!=='INCOMPLETE'||raw.validity.completeness==='COMPLETE'))throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
  const {checksum,...body}=raw;if(checksumBody(body)!==checksum)throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
  try{relationPolicyFromConfig(raw.policy);}catch{throw new SafeError('FRESHNESS_HISTORY_CORRUPT');}
  return raw as FreshnessAttempt;
}
export function readFreshnessHistory(universeId:string,relationId:string):FreshnessAttempt[]{
  const dir=historyDirectory(universeId,relationId,false);if(!fs.existsSync(dir))return [];
  const attemptsDir=path.join(dir,'attempts');if(!fs.existsSync(attemptsDir))return [];
  const stat=fs.lstatSync(attemptsDir);if(!stat.isDirectory()||stat.isSymbolicLink()||!isWithin(fs.realpathSync(attemptsDir),fs.realpathSync(path.resolve(ROOT,'.concordia'))))throw new SafeError('FRESHNESS_PATH_INVALID');
  const records:FreshnessAttempt[]=[];
  for(const name of fs.readdirSync(attemptsDir).sort()){
    if(!/^attempt-[a-f0-9-]{36}\.json$/.test(name))throw new SafeError('FRESHNESS_HISTORY_CORRUPT');
    const file=path.join(attemptsDir,name),leaf=fs.lstatSync(file);if(!leaf.isFile()||leaf.isSymbolicLink()||leaf.size>8*1024*1024||leaf.nlink!==1||!isWithin(fs.realpathSync(file),fs.realpathSync(attemptsDir)))throw new SafeError('FRESHNESS_HISTORY_UNSAFE');
    let parsed:any;try{parsed=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new SafeError('FRESHNESS_HISTORY_CORRUPT');}
    const record=validateAttempt(parsed);if(record.universeId!==universeId||record.relationId!==relationId)throw new SafeError('FRESHNESS_HISTORY_SCOPE_MISMATCH');records.push(record);
  }
  records.sort((a,b)=>a.sequence-b.sequence);
  if(records.some((record,index)=>record.sequence!==index+1))throw new SafeError('FRESHNESS_HISTORY_SEQUENCE_INVALID');
  return records;
}
function knownValue(value:any):string|undefined{return value&&value.state==='KNOWN'&&typeof value.value==='string'?value.value:undefined;}
function completeness(bundle:EvidenceBundle):EvidenceValidity['completeness']{
  if(bundle.completeness==='COMPLETE_FOR_SCOPE')return 'COMPLETE';if(bundle.completeness==='PARTIAL')return 'PARTIAL';if(bundle.completeness==='TRUNCATED')return 'TRUNCATED';if(bundle.completeness==='TRANSPORT_FAILED')return 'ERROR';return 'UNKNOWN';
}
export function sourceSchemaFingerprintFromHash(sourceId:string,objectId:string,sha256:unknown,provenance:string,observedAt?:string):SourceSchemaFingerprint{
  const time=observedAt&&Number.isFinite(Date.parse(observedAt))?{observedAt}:{};
  return typeof sourceId==='string'&&sourceId&&typeof objectId==='string'&&objectId&&/^[a-f0-9]{64}$/.test(String(sha256??''))
    ?{sourceId,objectId,state:'KNOWN',sha256:String(sha256),provenance,...time}
    :{sourceId,objectId,state:'UNKNOWN',provenance,...time};
}
export function sourceSchemaFingerprintFromDescription(sourceId:string,objectId:string,description:unknown,provenance:string,observedAt?:string):SourceSchemaFingerprint{
  if(description===undefined||description===null)return sourceSchemaFingerprintFromHash(sourceId,objectId,undefined,provenance,observedAt);
  const canonical=Array.isArray(description)?description.map(item=>stable(item)).sort():stable(description);
  return sourceSchemaFingerprintFromHash(sourceId,objectId,digest(canonical),provenance,observedAt);
}
function canonicalSchemaFingerprints(contract:RelationContract,provided:readonly SourceSchemaFingerprint[]=[]):SourceSchemaFingerprint[]{
  return [contract.from,contract.to].map(endpoint=>{
    const found=provided.find(item=>item.sourceId===endpoint.sourceId&&item.objectId===endpoint.objectId);
    if(!found)return sourceSchemaFingerprintFromHash(endpoint.sourceId,endpoint.objectId,undefined,'UNKNOWN');
    return sourceSchemaFingerprintFromHash(found.sourceId,found.objectId,found.state==='KNOWN'?found.sha256:undefined,found.provenance,found.observedAt);
  }).sort((a,b)=>a.sourceId.localeCompare(b.sourceId,'en')||a.objectId.localeCompare(b.objectId,'en'));
}
function fingerprintParts(contract:RelationContract,evidence:EvidenceBundle,providedSchema:readonly SourceSchemaFingerprint[]=[]){
  const observations=evidence.observations.map(item=>({
    item,
    shape:{sourceRef:item.sourceRef,projection:[...item.projection],filters:[...item.filters],limit:item.limit},
    rows:item.measuredTuples.map(row=>stable(row)).sort(),
    fingerprint:knownValue(item.fingerprint),
    token:knownValue(item.nativeVersion)
  })).sort((a,b)=>a.item.sourceRef.localeCompare(b.item.sourceRef,'en')||stable({shape:a.shape,rows:a.rows,fingerprint:a.fingerprint,token:a.token}).localeCompare(stable({shape:b.shape,rows:b.rows,fingerprint:b.fingerprint,token:b.token}),'en'));
  const hasNative=observations.length>0&&observations.every(item=>item.token!==undefined);
  const sourceToken=hasNative?digest(observations.map(item=>({shape:item.shape,token:item.token}))):null;
  const sourceFingerprint=observations.length?digest({scope:evidence.scope,observations:observations.map(item=>({...item.shape,rows:item.rows,fingerprint:item.fingerprint??null}))}):null;
  const schemaFingerprints=canonicalSchemaFingerprints(contract,providedSchema);
  const schemaFingerprint=digest({from:{sourceId:contract.from.sourceId,objectId:contract.from.objectId,columns:contract.from.orderedColumns},to:{sourceId:contract.to.sourceId,objectId:contract.to.objectId,columns:contract.to.orderedColumns},scope:evidence.scope,queryShape:observations.map(item=>item.shape),sourceSchema:schemaFingerprints.map(item=>({sourceId:item.sourceId,objectId:item.objectId,state:item.state,sha256:item.state==='KNOWN'?item.sha256:null,provenance:item.provenance}))});
  return {sourceToken,sourceFingerprint,schemaFingerprint,schemaFingerprints,fingerprintScope:sourceToken?'NATIVE_VERSION_TOKEN_SHA256' as const:observations.length?'BOUNDED_RESPONSE' as const:'UNKNOWN' as const};
}
export function recordFreshnessAttempt(input:{universeId:string;relationId:string;contract:RelationContract;evidence:EvidenceBundle;decision:Decision;policy:RelationPolicy;reads?:ProbeExecutionResult['reads'];errors?:ProbeExecutionResult['errors'];sourceSchemaFingerprints?:readonly SourceSchemaFingerprint[];checkedAt?:string;now?:()=>string}):FreshnessAttempt{
  if(validateRelationContract(input.contract).length||validateEvidenceBundle(input.evidence).length||validateDecision(input.decision).length||input.evidence.relationRef!==input.contract.id||input.evidence.contractVersion!==input.contract.contractVersion||input.decision.relationRef!==input.contract.id||input.decision.contractVersion!==input.contract.contractVersion)throw new SafeError('FRESHNESS_INPUT_INVALID');
  const policy=relationPolicyFromConfig(input.policy),dir=historyDirectory(input.universeId,input.relationId,true),release=acquireReconcileWriterLock(dir,input.universeId);
  try{
    const attemptsDir=path.join(dir,'attempts');if(!fs.existsSync(attemptsDir))fs.mkdirSync(attemptsDir);
    const latest=readFreshnessHistory(input.universeId,input.relationId),sequence=(latest.at(-1)?.sequence??0)+1,previous=[...latest].reverse().find(item=>item.validity.completeness==='COMPLETE');
    const checkedAt=input.checkedAt??input.evidence.observations.map(item=>item.checkedAt).sort().at(-1)??input.evidence.capturedAt;
    const observed=[...new Set(input.evidence.observations.map(item=>knownValue(item.observedAt)).filter((value):value is string=>Boolean(value)))].sort();
    const parts=fingerprintParts(input.contract,input.evidence,input.sourceSchemaFingerprints),base={observedAt:observed.length?observed.at(-1)!:null,checkedAt,sourceToken:parts.sourceToken,sourceFingerprint:parts.sourceFingerprint,schemaFingerprint:parts.schemaFingerprint,contractFingerprint:digest(input.contract),normalizationFingerprint:digest(input.contract.normalization),completeness:completeness(input.evidence),requestIds:input.evidence.observations.map(item=>knownValue(item.requestId)).filter((value):value is string=>Boolean(value))};
    const nowText=(input.now??(()=>new Date().toISOString()))();if(!Number.isFinite(Date.parse(nowText)))throw new SafeError('FRESHNESS_CLOCK_INVALID');
    const validity=assessEvidenceValidity(base,previous?.validity,undefined,Date.parse(nowText)),usable=validity.completeness==='COMPLETE';
    let comparison:FreshnessComparison='INCOMPLETE';
    if(usable){
      if(!previous)comparison='FIRST_CHECK';
      else{
        const sourceSame=parts.sourceToken&&previous.validity.sourceToken?parts.sourceToken===previous.validity.sourceToken:!parts.sourceToken&&!previous.validity.sourceToken&&parts.sourceFingerprint===previous.validity.sourceFingerprint;
        const provenanceSame=previous.executionMode===input.evidence.runRef.executionMode&&previous.dataOrigin===(typeof input.evidence.runRef.dataOrigin==='string'?input.evidence.runRef.dataOrigin:input.evidence.runRef.dataOrigin.label);
        comparison=sourceSame&&provenanceSame&&!validity.requiresReview&&validity.schemaFingerprint===previous.validity.schemaFingerprint&&validity.contractFingerprint===previous.validity.contractFingerprint&&validity.normalizationFingerprint===previous.validity.normalizationFingerprint?'REVALIDATED':'CHANGED_REQUIRES_REVIEW';
      }
    }
    const semanticSourceVersion=digest({sourceToken:parts.sourceToken,sourceFingerprint:parts.sourceFingerprint,schemaFingerprint:validity.schemaFingerprint,contractFingerprint:validity.contractFingerprint,normalizationFingerprint:validity.normalizationFingerprint,decision:{verdict:input.decision.verdict,policyVersion:input.decision.policyVersion}});
    const attemptId=`attempt:${randomUUID()}`,recordedAt=nowText;
    const sourceQueryHistory=(input.reads??[]).map(read=>({sourceId:read.sourceId,...(read.requestId?{requestId:read.requestId}:{}),...(read.queryId?{queryId:read.queryId}:{}),...(read.requestedAt?{requestedAt:read.requestedAt}:{}),...(read.observedAt?{observedAt:read.observedAt}:{}),...(read.statement?{statement:read.statement}:{})}));
    const transportFailures=(input.errors??[]).map(error=>({sourceRef:error.sourceRef,code:error.adapterCode,...(error.http!==undefined?{http:error.http}:{}),...(error.retryAfter?{retryAfter:error.retryAfter}:{})}));
    const body={schemaVersion:1 as const,sequence,kind:'EVIDENCE' as const,attemptId,universeId:input.universeId,relationId:input.relationId,relationRef:input.contract.id,recordedAt,executionMode:input.evidence.runRef.executionMode,dataOrigin:typeof input.evidence.runRef.dataOrigin==='string'?input.evidence.runRef.dataOrigin:input.evidence.runRef.dataOrigin.label,comparison,validity,fingerprintScope:parts.fingerprintScope,scopeDescription:parts.fingerprintScope==='BOUNDED_RESPONSE'?'Hash of bounded returned tuple multiset, declared scope, projection and limit; not global source identity or coverage.':parts.fingerprintScope==='NATIVE_VERSION_TOKEN_SHA256'?'Hash of adapter-exposed native version tokens by endpoint.':'No native token or bounded observation available.',semanticSourceVersion,latestCompleteAttemptRef:usable?attemptId:(previous?.attemptId??null),contract:input.contract,policy,schemaFingerprints:parts.schemaFingerprints,evidence:input.evidence,decision:input.decision,sourceQueryHistory,transportFailures};
    const record={...body,checksum:checksumBody(body)} as FreshnessAttempt,file=path.join(attemptsDir,`attempt-${attemptId.slice('attempt:'.length)}.json`);
    atomicWriteFile(file,Buffer.from(JSON.stringify(record,null,2)+'\n','utf8'));return record;
  }finally{release();}
}
export function recordFreshnessPreflightFailure(input:{universeId:string;relationId:string;contract:RelationContract;policy:RelationPolicy;sourceValidation:any;executionMode:'LIVE'|'LOCAL'|'REPLAY'|'UNKNOWN';dataOrigin:string;checkedAt:string}):FreshnessAttempt{
  if(!safeId(input.universeId)||validateRelationContract(input.contract).length||!Number.isFinite(Date.parse(input.checkedAt)))throw new SafeError('FRESHNESS_PREFLIGHT_INPUT_INVALID');
  const policy=relationPolicyFromConfig(input.policy),dir=historyDirectory(input.universeId,input.relationId,true),release=acquireReconcileWriterLock(dir,input.universeId);
  try{
    const attemptsDir=path.join(dir,'attempts');if(!fs.existsSync(attemptsDir))fs.mkdirSync(attemptsDir);
    const latest=readFreshnessHistory(input.universeId,input.relationId),sequence=(latest.at(-1)?.sequence??0)+1,previous=[...latest].reverse().find(item=>item.validity.completeness==='COMPLETE');
    const sourceIds=new Set([input.contract.from.sourceId,input.contract.to.sourceId]);
    const tables=Array.isArray(input.sourceValidation?.tables)?input.sourceValidation.tables.filter((table:any)=>sourceIds.has(table.sourceId)):[];
    const sourceQueryHistory:FreshnessAttempt['sourceQueryHistory']=tables.flatMap((table:any)=>[
      ...(table.describeRequestId||table.describeQueryId||table.describeStatement?[{sourceId:table.sourceId,...(table.describeRequestId?{requestId:table.describeRequestId}:{}),...(table.describeQueryId?{queryId:table.describeQueryId}:{}),...(table.describeRequestedAt?{requestedAt:table.describeRequestedAt}:{}),...(table.describeStatement?{statement:table.describeStatement}:{})}]:[]),
      ...(table.selectRequestId||table.selectQueryId||table.selectStatement?[{sourceId:table.sourceId,...(table.selectRequestId?{requestId:table.selectRequestId}:{}),...(table.selectQueryId?{queryId:table.selectQueryId}:{}),...(table.selectRequestedAt?{requestedAt:table.selectRequestedAt}:{}),...(table.selectStatement?{statement:table.selectStatement}:{})}]:[])
    ]);
    const schemaFingerprints:SourceSchemaFingerprint[]=tables.filter((table:any)=>typeof table.logicalObjectId==='string').map((table:any)=>sourceSchemaFingerprintFromHash(table.sourceId,table.logicalObjectId,table.observedSchemaSha256,'JSON2_SOURCE_PREFLIGHT',table.describeRequestedAt));
    const canonicalSchemas=canonicalSchemaFingerprints(input.contract,schemaFingerprints),failure=input.sourceValidation?.failure;
    const transportFailures=[...(failure?[{sourceRef:String(failure.sourceId??''),code:String(failure.code??'SOURCE_PREFLIGHT_FAILED'),...(failure.http!==undefined?{http:failure.http}:{}),...(failure.retryAfter?{retryAfter:String(failure.retryAfter)}:{})}]:[]),...tables.filter((table:any)=>table.status==='ERROR').map((table:any)=>({sourceRef:table.sourceId,code:'SOURCE_PREFLIGHT_FAILED'}))];
    const attemptId=`attempt:${randomUUID()}`,validity:EvidenceValidity={observedAt:null,checkedAt:input.checkedAt,sourceToken:null,sourceFingerprint:null,schemaFingerprint:digest({from:input.contract.from,to:input.contract.to,sourceSchema:canonicalSchemas.map(item=>({sourceId:item.sourceId,objectId:item.objectId,state:item.state,sha256:item.state==='KNOWN'?item.sha256:null,provenance:item.provenance}))}),contractFingerprint:digest(input.contract),normalizationFingerprint:digest(input.contract.normalization),completeness:'ERROR',requestIds:sourceQueryHistory.map(item=>item.requestId).filter((value):value is string=>Boolean(value)),state:'INCOMPLETE',requiresReview:true};
    const semanticSourceVersion=digest({contractFingerprint:validity.contractFingerprint,preflightFailure:transportFailures,schemaFingerprint:validity.schemaFingerprint});
    const body={schemaVersion:1 as const,sequence,kind:'PREFLIGHT_FAILURE' as const,attemptId,universeId:input.universeId,relationId:input.relationId,relationRef:input.contract.id,recordedAt:input.checkedAt,executionMode:input.executionMode,dataOrigin:input.dataOrigin,comparison:'INCOMPLETE' as const,validity,fingerprintScope:'UNKNOWN' as const,scopeDescription:'Source preflight failed before relation evaluation; no relation decision was executed.',semanticSourceVersion,latestCompleteAttemptRef:previous?.attemptId??null,contract:input.contract,policy,schemaFingerprints:canonicalSchemas,evidence:null,decision:null,sourceQueryHistory,transportFailures};
    const record={...body,checksum:checksumBody(body)} as FreshnessAttempt,file=path.join(attemptsDir,`attempt-${attemptId.slice(8)}.json`);
    atomicWriteFile(file,Buffer.from(JSON.stringify(record,null,2)+'\n','utf8'));return record;
  }finally{release();}
}
export function replayFreshnessAttempt(universeId:string,relationId:string,attemptId:string){
  const record=readFreshnessHistory(universeId,relationId).find(item=>item.attemptId===attemptId);if(!record)throw new SafeError('FRESHNESS_ATTEMPT_NOT_FOUND');
  const decision=record.evidence&&record.decision?evaluateRelation(record.contract,[record.evidence],record.policy):null;
  return {status:decision?'REPLAYED' as const:'INCOMPLETE' as const,attemptId:record.attemptId,universeId,relationId,sourceExecutionMode:record.executionMode,executionMode:'REPLAY' as const,dataOrigin:record.dataOrigin,validity:record.validity,comparison:record.comparison,decision,sourceQueryHistory:record.sourceQueryHistory,transportFailures:record.transportFailures};
}
export function freshnessHistoryView(universeId:string,relationId:string,now=Date.now(),ttlMs?:number){
  return readFreshnessHistory(universeId,relationId).map(record=>{
    const age=now-Date.parse(record.validity.checkedAt),expired=ttlMs!==undefined&&ttlMs>=0&&age>ttlMs;
    const displayStatus=record.validity.completeness!=='COMPLETE'?'INCOMPLETE':expired?'PENDING_RECHECK':record.comparison;
    return {attemptId:record.attemptId,sequence:record.sequence,recordedAt:record.recordedAt,comparison:record.comparison,displayStatus,validity:record.validity,fingerprintScope:record.fingerprintScope,scopeDescription:record.scopeDescription,latestCompleteAttemptRef:record.latestCompleteAttemptRef,decision:record.decision,sourceExecutionMode:record.executionMode,dataOrigin:record.dataOrigin,schemaFingerprints:record.schemaFingerprints,sourceQueryHistory:record.sourceQueryHistory,transportFailures:record.transportFailures};
  });
}
