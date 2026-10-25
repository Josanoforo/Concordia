import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, readJson } from '../src/runtime.ts';
const svp1Profiles=loadSvp1Profiles();
import { evaluateSvp1Snapshot, evaluateSvp1Suite, loadSvp1Profiles, resolveSvp1Profile, synthesizeCandidateContract, validateSvp1Manifest, validateSvp1Profiles } from '../src/svp1.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';
import { assertCapturedRunInputsCurrent } from '../src/registry/runs.ts';

test('SVP1 profiles validate offline with stable universe IDs and scoped aliases',()=>{
  assert.deepEqual(validateSvp1Profiles(svp1Profiles),[]);
  assert.equal(resolveSvp1Profile('GTFS_SVP1')?.manifestId,'concordia.universe.gtfs-svp1');
  assert.deepEqual(resolveSvp1Profile('concordia.universe.gtfs-svp1'),resolveSvp1Profile('GTFS_SVP1'));
  const registered=resolveUniverseManifest('concordia.universe.gtfs-svp1')!;
  assert.deepEqual(validateSvp1Manifest({...registered,source:{...registered.source,configPath:'universes/thirdparty_fixture.json'}},svp1Profiles.filter(item=>item.manifestId===registered.manifestId)),[]);
  assert.equal(resolveSvp1Profile('CHINOOK_SVP1')?.manifestId,'concordia.universe.chinook-svp1');
  assert.equal(resolveSvp1Profile('NORTHWIND_SVP1')?.manifestId,'vendor.universe.northwind-known-reserve');
  assert.equal(resolveUniverseManifest('GTFS')?.manifestId,'concordia.universe.gtfs');
  assert.equal(resolveUniverseManifest('GTFS_SVP1')?.manifestId,'concordia.universe.gtfs-svp1');
  assert.equal(resolveUniverseManifest('CHINOOK')?.manifestId,'concordia.universe.chinook');
  assert.equal(resolveUniverseManifest('CHINOOK_SVP1')?.manifestId,'concordia.universe.chinook-svp1');
  const escaped=structuredClone(svp1Profiles);escaped[0].tables[0].dataPath='../outside.json';
  assert.ok(validateSvp1Profiles(escaped).some(issue=>issue.code==='SNAPSHOT_PATH_OUTSIDE_APPROVED_ROOT'));
  const overBound=structuredClone(svp1Profiles);overBound[0].tables[0].rowLimit=21;
  assert.ok(validateSvp1Profiles(overBound).some(issue=>issue.code==='ROW_BOUND_EXCEEDED'));
  const malformed=structuredClone(svp1Profiles);(malformed[0] as any).tables[0]=null;(malformed[0] as any).relations[0].from={sourceId:'x',objectId:'y'};
  assert.doesNotThrow(()=>validateSvp1Profiles(malformed));
  assert.ok(validateSvp1Profiles(malformed).some(issue=>issue.code==='EXPECTED_TABLE_OBJECT'));
  assert.ok(validateSvp1Profiles(malformed).some(issue=>issue.code==='INVALID_RELATION_ENDPOINT'));
});

test('synthetic candidates do not inherit identifier space from their containing universe',()=>{
  const profile:any={manifestId:'fixture.universe.synthetic',version:'1.0.0',namespace:'container:alpha',tables:[
    {tableId:'left',sourceId:'left-source',objectId:'db.left',columns:['id'],types:['string']},
    {tableId:'right',sourceId:'right-source',objectId:'db.right',columns:['id'],types:['string']}
  ]};
  const candidate:any={candidateId:'synthetic-fk',task:'FOREIGN_KEY',from:{universe:profile.manifestId,table:'left',orderedColumns:['id']},to:{universe:profile.manifestId,table:'right',orderedColumns:['id']},proposedBy:'synthetic-test'};
  const generated=synthesizeCandidateContract(candidate,profile)!;
  assert.deepEqual(generated.universeRef.namespace,{state:'KNOWN',value:'container:alpha'});
  assert.deepEqual(generated.identifierSpace,{state:'UNKNOWN'});
  const declared=synthesizeCandidateContract({...candidate,identifierSpace:{state:'KNOWN',value:'shared-id-space'}},profile)!;
  assert.deepEqual(declared.identifierSpace,{state:'KNOWN',value:'shared-id-space'});
  const malformed=structuredClone(svp1Profiles);(malformed[0].candidates[0] as any).identifierSpace={state:'KNOWN',value:17};
  assert.ok(validateSvp1Profiles(malformed).some(issue=>issue.path.endsWith('.identifierSpace')));
});

test('SVP1 evaluates supplied FK contracts and accounts for every candidate without truth data',async()=>{
  const result=await evaluateSvp1Snapshot('GTFS_SVP1',{runId:'svp1-test-gtfs-0001'});
  assert.equal(result.executionMode,'LOCAL');
  assert.equal(result.candidateCount,6);
  assert.equal(result.predictions.length,6);
  assert.equal(result.decisions.length,4);
  assert.deepEqual(result.decisions.map(item=>item.candidateId).sort(),['G01','G02','G03','G06']);
  assert.ok(result.predictions.filter(item=>item.status==='NOT_RUN').every(item=>item.queryStatus==='NOT_QUERIED'&&item.queryRefs.length===0));
  assert.equal(result.predictions.find(item=>item.candidateId==='G06')?.status,'EVALUATED');
  assert.ok(result.predictions.find(item=>item.candidateId==='G06')?.reasonCodes.includes('identifier_space_or_namespace_unknown'));
  assert.deepEqual(result.predictions.find(item=>item.candidateId==='G06')?.inputVariantApplied,['identifierSpace']);
  assert.deepEqual(result.predictions.find(item=>item.candidateId==='G06')?.ablationComparison?.baselineReasonCodes,['relation_contract_not_reviewed']);
  assert.deepEqual(result.predictions.find(item=>item.candidateId==='G06')?.ablationComparison?.variantReasonCodes,['identifier_space_or_namespace_unknown']);
  assert.equal(result.predictions.find(item=>item.candidateId==='G06')?.task,'METADATA_OMISSION_CONTROL');
  assert.equal(result.predictions.find(item=>item.candidateId==='G06')?.queryStatus,'COMPLETE');
  assert.deepEqual(result.predictions.find(item=>item.candidateId==='G06')?.queryRefs,result.predictions.find(item=>item.candidateId==='G01')?.queryRefs);
  assert.equal(result.predictions.find(item=>item.candidateId==='G06')?.truthStatus,'NOT_SCORED');
  assert.equal(result.predictions.find(item=>item.candidateId==='G04')?.reason,'unsupported_relation_kind_unique_key');

  assert.equal(result.decisions.every(item=>item.contractVersion==='1.0'),true);
  const chinook=await evaluateSvp1Snapshot('CHINOOK_SVP1',{runId:'svp1-test-chinook-0001'});
  assert.equal(chinook.dataOrigin,'UNKNOWN');
  assert.equal(chinook.predictions.find(item=>item.candidateId==='C01')?.dataOrigin,'PUBLIC');
  assert.equal(chinook.decisions.find(item=>item.candidateId==='C01')?.evidenceBundle.runRef.dataOrigin,'PUBLIC');
  assert.equal(chinook.comparisonEnvelopes.product.frozenInputHash,chinook.comparisonEnvelopes.metadataOmissionAblation.frozenInputHash);
  assert.equal(chinook.comparisonEnvelopes.product.outcomes.length,chinook.candidateCount);
  assert.equal(chinook.comparisonEnvelopes.metadataOmissionAblation.outcomes.length,chinook.candidateCount);
  assert.deepEqual(chinook.comparisonEnvelopes.product.outcomes.map(item=>item.caseId),chinook.comparisonEnvelopes.metadataOmissionAblation.outcomes.map(item=>item.caseId));
  assert.equal(chinook.comparisonEnvelopes.metadataOmissionAblation.outcomes.find(item=>item.caseId==='C03')?.action,'NOT_QUERIED');
  assert.equal(chinook.causalControls.length,1);
  assert.equal(chinook.comparisonEnvelopes.product.split,'KNOWN_EVALUATION_RESERVE');
  assert.equal(chinook.comparisonEnvelopes.product.freezeStatus,'PENDING_ROOT_FREEZE');
  assert.equal(chinook.candidateCount,5);
  const northwind=await evaluateSvp1Snapshot('NORTHWIND_SVP1',{runId:'svp1-test-northwind-0001'});
  assert.equal(northwind.candidateCount,6);
  assert.equal(northwind.dataOrigin,'SYNTHETIC');
});

test('SVP1 CLI eval replays the same local evaluator decision offline',async()=>{
  const args=[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/cli.ts'),'eval','--universe','GTFS_SVP1','--run-id','svp1-test-cli-0001'];
  const output=execFileSync(process.execPath,args,{cwd:ROOT,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(ROOT,'.concordia','must-not-load.env')}});
  const cli=JSON.parse(output);
  assert.equal(cli.status,'EVALUATED');
  const direct=await evaluateSvp1Snapshot('GTFS_SVP1',{runId:'svp1-test-cli-0001'});
  assert.deepEqual(cli.predictions,direct.predictions);
  assert.deepEqual(cli.decisions.map((item:any)=>item.decision.verdict),direct.decisions.map((item:any)=>item.decision.verdict));
});


test('SVP1 serial suite accounts for all 17 candidates and CLI matches the common evaluator',async()=>{
  const runId='svp1-test-suite-0001';
  const direct=await evaluateSvp1Suite({runId});
  assert.equal(direct.candidateCount,17);
  assert.equal(direct.predictions.length,17);
  assert.equal(direct.methodEnvelopes.product.outcomes.length,17);
  assert.equal(direct.methodEnvelopes.metadataOmissionAblation.outcomes.length,17);
  assert.deepEqual(direct.methodEnvelopes.product.outcomes.map(item=>item.caseId),direct.methodEnvelopes.metadataOmissionAblation.outcomes.map(item=>item.caseId));
  for(const envelope of [direct.methodEnvelopes.product,direct.methodEnvelopes.metadataOmissionAblation]){
    for(const field of ['method','version','productCommit','policyVersion','budgetId','frozenAtUtc','runtimeSha256','candidateSha256','split','executionMode','dataOrigin','outcomes'])assert.ok(Object.hasOwn(envelope,field));
    assert.equal(envelope.productCommit,null);assert.equal(envelope.frozenAtUtc,null);assert.equal(envelope.runtimeSha256,null);assert.equal(envelope.candidateSha256,null);assert.match(envelope.adaptedConfigSha256,/^[a-f0-9]{64}$/);assert.equal(envelope.freezeStatus,'PENDING_ROOT_FREEZE');
    assert.ok(envelope.outcomes.every(item=>['ACCEPT','REJECT','ABSTAIN','REVIEW','ERROR','NOT_QUERIED'].includes(item.action)));
  }
  assert.equal(direct.freezeStatus,'PENDING_ROOT_FREEZE');
  assert.equal(direct.causalControls.length,3);
  assert.equal(direct.decisions.length,9);
  assert.equal(direct.predictions.filter(item=>item.task==='UNIQUE_KEY'&&item.reason==='unsupported_relation_kind_unique_key').length,6);
  assert.equal(direct.predictions.filter(item=>item.status==='EVALUATED').length,9);
  assert.equal(direct.predictions.filter(item=>item.status==='NOT_RUN').length,6);
  assert.equal(direct.predictions.filter(item=>item.status==='NOT_EVALUABLE').length,2);
  const output=execFileSync(process.execPath,[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/cli.ts'),'universe','evaluate','--all-svp1','--run-id',runId],{cwd:ROOT,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(ROOT,'.concordia','must-not-load.env')}});
  const cli=JSON.parse(output);
  assert.equal(cli.status,'EVALUATED');
  assert.deepEqual(cli.predictions,direct.predictions);
  assert.deepEqual(cli.decisions.map((item:any)=>item.decision.verdict),direct.decisions.map(item=>item.decision.verdict));
});






test('SVP1 CLI captures and reuses a verified local snapshot without reevaluation after source drift',()=>{
  const scratch=fs.mkdtempSync(path.join(ROOT,'.concordia','svp1-capture-test-'));
  const project=path.join(scratch,'project');fs.mkdirSync(project,{recursive:true});
  try{
    for(const directory of ['src','config','universes','data/snapshots','scripts'])fs.cpSync(path.join(ROOT,directory),path.join(project,directory),{recursive:true});
    for(const file of ['package.json','package-lock.json','tsconfig.json'])fs.copyFileSync(path.join(ROOT,file),path.join(project,file));
    const cli=(args:string[])=>execFileSync(process.execPath,[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),...args],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(project,'.concordia','must-not-load.env')}});
    const args=['universe','evaluate','--universe','GTFS_SVP1','--capture-run','svp1-capture-01','--run-registry-dir','.concordia/run-registry/svp1-test'];
    const mismatch=spawnSync(process.execPath,[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),...args,'--run-id','different-evaluation-id'],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(project,'.concordia','must-not-load.env')}});
    assert.notEqual(mismatch.status,0);assert.equal(fs.existsSync(path.join(project,'.concordia/run-registry/svp1-test')),false);
    const first=JSON.parse(cli(args));assert.equal(first.status,'EVALUATED');assert.equal(first.runRegistryStatus,'RECORDED');
    const recordPath=path.join(project,'.concordia/run-registry/svp1-test/captures/svp1-capture-01.json');
    const record=JSON.parse(fs.readFileSync(recordPath,'utf8'));assert.match(record.sourceInputHash,/^[a-f0-9]{64}$/);assert.equal(record.executionMode,'LOCAL');
    const second=JSON.parse(cli(args));assert.equal(second.status,'CAPTURE_REUSED');assert.equal(second.runRegistryStatus,'REUSED');
    const directEval=JSON.parse(cli(['eval','--universe','concordia.universe.gtfs-svp1','--capture-run','svp1-capture-02','--run-registry-dir','.concordia/run-registry/svp1-test']));
    assert.equal(directEval.status,'EVALUATED');assert.equal(directEval.runRegistryStatus,'RECORDED');
    const profile=JSON.parse(fs.readFileSync(path.join(project,'universes/svp1-snapshots.json'),'utf8')).find((item:any)=>item.alias==='GTFS_SVP1');
    const sourceFile=path.join(project,...profile.tables[0].dataPath.split('/'));const original=fs.readFileSync(sourceFile);fs.appendFileSync(sourceFile,' ');
    assert.throws(()=>assertCapturedRunInputsCurrent(record,project),/RUN_REGISTRY_SNAPSHOT_HASH_MISMATCH/);
    const rejected=spawnSync(process.execPath,[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),...args],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(project,'.concordia','must-not-load.env')}});
    assert.notEqual(rejected.status,0);fs.writeFileSync(sourceFile,original);
    assert.equal(fs.readFileSync(path.join(project,'.concordia/run-registry/svp1-test/runs.jsonl'),'utf8').trim().split('\n').length,2);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
});


test('SVP1 CLI resolves a fourth snapshot through its own manifest config without the default snapshot file',()=>{
  const scratch=fs.mkdtempSync(path.join(ROOT,'.concordia','svp1-alternate-config-test-')),project=path.join(scratch,'project');fs.mkdirSync(project,{recursive:true});
  try{
    for(const directory of ['src','config','universes','data/snapshots'])fs.cpSync(path.join(ROOT,directory),path.join(project,directory),{recursive:true});
    for(const file of ['package.json','tsconfig.json'])fs.copyFileSync(path.join(ROOT,file),path.join(project,file));
    const profile=structuredClone(loadSvp1Profiles()[0]) as any,manifestId='vendor.universe.fourth-svp1',alias='FOURTH_SVP1',namespace='fourth:1';
    const sourceMap=new Map<string,string>(),objectMap=new Map<string,string>();
    for(const table of profile.tables){sourceMap.set(table.sourceId,`fourth:${table.tableId}`);objectMap.set(table.objectId,`FOURTH.${table.tableId}`);}
    profile.manifestId=manifestId;profile.alias=alias;profile.version='1.0.0';profile.registrySourceId='fourth-pinned-source';profile.namespace=namespace;
    for(const table of profile.tables){table.sourceId=sourceMap.get(table.sourceId);table.objectId=objectMap.get(table.objectId);}
    const relationMap=new Map<string,string>();for(const relation of profile.relations)relationMap.set(relation.id,`fourth_${relation.id}`);
    for(const relation of profile.relations){relation.id=relationMap.get(relation.id);relation.universeRef.universeId=manifestId;relation.universeRef.universeVersion={state:'KNOWN',value:profile.version};relation.universeRef.namespace={state:'KNOWN',value:namespace};relation.identifierSpace={state:'KNOWN',value:namespace};for(const side of ['from','to']){relation[side].sourceId=sourceMap.get(relation[side].sourceId);relation[side].objectId=objectMap.get(relation[side].objectId);relation[side].namespace={state:'KNOWN',value:namespace};}}
    for(const candidate of profile.candidates){candidate.from.universe=alias;candidate.to.universe=alias;if(candidate.relationContractRef)candidate.relationContractRef=relationMap.get(candidate.relationContractRef);if(candidate.baseRelationContractRef)candidate.baseRelationContractRef=relationMap.get(candidate.baseRelationContractRef);}
    const configPath='universes/fourth-svp1-config.json';fs.writeFileSync(path.join(project,configPath),JSON.stringify([profile],null,2)+'\n');
    const registryPath=path.join(project,'universes/registry.json'),registry=JSON.parse(fs.readFileSync(registryPath,'utf8')).filter((item:any)=>!['local-snapshot','zetaris-json2-live'].includes(item.source.adapterId));
    registry.push({schemaVersion:1,manifestId,version:profile.version,aliases:[alias],source:{sourceId:profile.registrySourceId,adapterId:'local-snapshot',configPath,dataOrigin:profile.dataOrigin},capabilities:['LOCAL_EVALUATION','RELATION_EVALUATION'],relationIds:profile.relations.map((item:any)=>item.id),capabilityBounds:{LOCAL_EVALUATION:{sampleLimit:profile.bounds.maxRows,probeLimit:profile.bounds.probeLimit,maxRelationsPerRun:profile.relations.length,maxKeyColumns:profile.bounds.maxKeyColumns}}});
    fs.writeFileSync(registryPath,JSON.stringify(registry,null,2)+'\n');fs.rmSync(path.join(project,'universes/svp1-snapshots.json'));
    const run=(...args:string[])=>execFileSync(process.execPath,[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),...args],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(project,'.concordia','must-not-load.env')}});
    assert.equal(JSON.parse(run('universe','validate')).status,'VALID');
    const evaluated=JSON.parse(run('universe','evaluate','--universe',manifestId,'--run-id','fourth-profile-run-01'));
    assert.equal(evaluated.status,'EVALUATED');assert.equal(evaluated.manifestId,manifestId);assert.equal(evaluated.candidateCount,profile.candidates.length);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
});
