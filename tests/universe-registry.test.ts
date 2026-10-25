import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../src/runtime.ts';
import { assertValidUniverseRegistry, resolveUniverseManifest, universeManifests, validateThirdPartyUniverseManifest, validateUniverseRegistry } from '../src/registry/universes.ts';
import { evaluateLocalFixtureUniverse, universeConfig } from '../src/universe-pipeline.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { resolveUniverseRoute } from '../src/universe-adapters.ts';
import { evaluateSchemaCorrespondence } from '../src/relations/schema-correspondence.ts';

test('C1 registry declares stable manifests and preserves U1/U2/U3 aliases', () => {
  assert.deepEqual(validateUniverseRegistry(universeManifests), []);
  assert.doesNotThrow(assertValidUniverseRegistry);
  for (const alias of ['U1', 'U2', 'U3']) assert.equal(resolveUniverseManifest(alias)?.aliases[0], alias);
  assert.equal(resolveUniverseManifest('concordia.universe.sec-companies')?.aliases[0], 'U2');
  assert.equal(resolveUniverseManifest('U1')?.version, '2.0.0');
  assert.equal(resolveUniverseManifest('U2')?.version, '2.0.0');
  assert.equal(resolveUniverseManifest('unknown'), undefined);
  assert.equal(resolveUniverseManifest('U3')?.capabilities.includes('BOUNDED_RELATION_PROBE'), true);
  assert.equal(resolveUniverseManifest('U3')?.source.adapterId,'madi-schema');
  assert.equal(resolveUniverseRoute(resolveUniverseManifest('U1')!,'probe'),'zetaris-u1-legacy');
  assert.equal(resolveUniverseRoute(resolveUniverseManifest('U2')!,'probe'),'zetaris-generic');
  assert.equal(resolveUniverseRoute(resolveUniverseManifest('U3')!,'probe'),'madi-schema');
  assert.equal(resolveUniverseRoute(resolveUniverseManifest('GTFS')!,'eval'),'local-fixture');
  assert.equal(resolveUniverseManifest('U2')?.relationIds.length, 3);
  assert.equal(resolveUniverseManifest('GTFS')?.manifestId, 'concordia.universe.gtfs');
  assert.equal(resolveUniverseManifest('CHINOOK')?.manifestId, 'concordia.universe.chinook');
  assert.equal(resolveUniverseManifest('GTFS')?.capabilities.join(','), 'LOCAL_EVALUATION,RELATION_EVALUATION');
  assert.equal(resolveUniverseManifest('CHINOOK')?.capabilities.join(','), 'LOCAL_EVALUATION,RELATION_EVALUATION');
  assert.equal(resolveUniverseManifest('TRAINING_FIXTURE')?.manifestId, 'vendor.universe.training-fixture');
  assert.deepEqual(['U1', 'U2', 'U3'].map(alias => universeConfig(alias).id), ['U1', 'U2', 'U3']);
});

test('C1 validates third-party manifests offline and rejects alias, capability and path violations', () => {
  const candidate: any = {
    schemaVersion: 1, manifestId: 'vendor.universe.fixture', version: '2.1.0', aliases: ['FIXTURE_X'],
    source: { sourceId: 'fixture-source', adapterId: 'local-files', configPath: 'universes/U1_ny_taxi.json', dataOrigin: 'SYNTHETIC' },
    capabilities: ['LOCAL_EVALUATION'], relationIds: ['fixture_relation'], capabilityBounds: { LOCAL_EVALUATION: { sampleLimit: 2, probeLimit: 50, maxRelationsPerRun: 1, maxKeyColumns: 1 } }
  };
  assert.deepEqual(validateThirdPartyUniverseManifest(candidate), []);
  assert.ok(validateThirdPartyUniverseManifest({ ...candidate, aliases: ['U1'] }).some(issue => issue.code === 'DUPLICATE_ALIAS'));
  assert.ok(validateThirdPartyUniverseManifest({ ...candidate, source: { ...candidate.source, configPath: '../external.json' } }).some(issue => issue.code === 'INVALID_CONFIG_PATH'));
  assert.ok(validateThirdPartyUniverseManifest({ ...candidate, capabilities: ['NETWORK_ACCESS'] as any }).some(issue => issue.code === 'INVALID_CAPABILITIES'));
  assert.ok(validateThirdPartyUniverseManifest({ ...candidate, source: { ...candidate.source, adapterId: 'local-files' }, capabilities: ['BOUNDED_RELATION_PROBE'] }).some(issue => issue.code === 'CAPABILITY_UNSUPPORTED_BY_ADAPTER'));
  assert.ok(validateThirdPartyUniverseManifest({ ...candidate, aliases: ['concordia.universe.sec-companies'] }).some(issue => issue.code === 'MANIFEST_ID_ALIAS_COLLISION'));
});

test('C1 validation catches duplicate aliases, invalid versions, unsupported capability and unsafe paths', () => {
  const changed = structuredClone(universeManifests) as any[];
  changed[1].aliases = ['U1'];
  changed[1].version = 'latest';
  changed[1].source.configPath = '../secrets.json';
  changed[1].capabilities = ['UNDECLARED'];
  const issues = validateUniverseRegistry(changed);
  assert.ok(issues.some(issue => issue.code === 'DUPLICATE_ALIAS'));
  assert.ok(issues.some(issue => issue.code === 'INVALID_MANIFEST_VERSION'));
  assert.ok(issues.some(issue => issue.code === 'INVALID_CONFIG_PATH'));
  assert.ok(issues.some(issue => issue.code === 'INVALID_CAPABILITIES'));
});

test('C1 CLI validates approved configs offline and rejects malformed keys, limits, allowlists and collisions',()=>{
  const slug=`candidate-${randomUUID().replaceAll('-','')}`;
  const relativeManifest=`universes/${slug}.json`,relativeConfig=`universes/${slug}-config.json`;
  const absoluteManifest=path.join(ROOT,relativeManifest),absoluteConfig=path.join(ROOT,relativeConfig);
  const scratch=fs.mkdtempSync(path.join(ROOT,'.concordia','universe-validate-cli-'));
  const preload=path.join(scratch,'deny-network.mjs'),missingEnv=path.join(scratch,'must-not-load.env');
  const config:any=structuredClone(universeConfig('TRAINING_FIXTURE'));
  config.id=slug.toUpperCase();config.namespace=slug;
  for(const table of Object.values<any>(config.tables))table.db=slug;
  const relationId=`${slug}_relation`;
  config.relations[0].id=relationId;config.relations[0].from.db=slug;config.relations[0].to.db=slug;
  const manifest:any={
    schemaVersion:1,manifestId:`vendor.universe.${slug}`,version:'1.0.0',aliases:[slug.toUpperCase()],
    source:{sourceId:`${slug}-source`,adapterId:'local-files',configPath:relativeConfig,dataOrigin:'SYNTHETIC'},
    capabilities:['LOCAL_EVALUATION','RELATION_EVALUATION'],relationIds:[relationId],
    capabilityBounds:{LOCAL_EVALUATION:{sampleLimit:2,probeLimit:50,maxRelationsPerRun:1,maxKeyColumns:1}}
  };
  assert.equal(fs.existsSync(absoluteManifest),false);assert.equal(fs.existsSync(absoluteConfig),false);
  fs.writeFileSync(preload,`import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
  const run=(candidate:any=manifest,candidateConfig:any=config)=>{
    fs.writeFileSync(absoluteManifest,JSON.stringify(candidate));fs.writeFileSync(absoluteConfig,JSON.stringify(candidateConfig));
    return spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/cli.ts'),'universe','validate','--manifest',relativeManifest],{cwd:ROOT,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:missingEnv}});
  };
  try{
    const valid=run();assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).status,'VALID');
    const missingSource={...manifest,source:undefined};
    const missingSourceRun=run(missingSource,config);
    assert.equal(missingSourceRun.status,1,missingSourceRun.stderr);
    assert.ok(JSON.parse(missingSourceRun.stdout).issues.some((issue:any)=>issue.code==='EXPECTED_SOURCE_OBJECT'));    fs.writeFileSync(absoluteManifest,JSON.stringify({...manifest,source:{...manifest.source,sourceId:42}}));
    fs.writeFileSync(absoluteConfig,'{"tables":');
    const invalidSource=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/cli.ts'),'universe','validate','--manifest',relativeManifest],{cwd:ROOT,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:missingEnv}});
    assert.equal(invalidSource.status,1,invalidSource.stderr);
    const invalidSourceIssues=JSON.parse(invalidSource.stdout).issues;
    assert.ok(invalidSourceIssues.some((issue:any)=>issue.code==='INVALID_SOURCE_ID'));
    assert.equal(invalidSourceIssues.some((issue:any)=>issue.code==='CONFIG_JSON_INVALID'),false);
    fs.writeFileSync(absoluteManifest,JSON.stringify(manifest));
    fs.writeFileSync(absoluteConfig,'{"tables":');
    const malformedConfig=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/cli.ts'),'universe','validate','--manifest',relativeManifest],{cwd:ROOT,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:missingEnv}});
    assert.equal(malformedConfig.status,1,malformedConfig.stderr);
    assert.ok(JSON.parse(malformedConfig.stdout).issues.some((issue:any)=>issue.code==='CONFIG_JSON_INVALID'));
    const missingKey=structuredClone(config);delete missingKey.relations[0].from.column;
    assert.ok(JSON.parse(run(manifest,missingKey).stdout).issues.some((issue:any)=>issue.code==='MISSING_RELATION_KEY'));
    const missingLimit=structuredClone(config);delete missingLimit.probeLimit;
    assert.ok(JSON.parse(run(manifest,missingLimit).stdout).issues.some((issue:any)=>issue.code==='MISSING_OR_INVALID_CONFIG_LIMIT'));
    const outsideColumn=structuredClone(config);outsideColumn.relations[0].from.column='not_allowlisted';
    const outsideColumnIssues=JSON.parse(run(manifest,outsideColumn).stdout).issues;assert.ok(outsideColumnIssues.some((issue:any)=>issue.code==='CONFIG_COLUMN_OUTSIDE_ALLOWLIST'),JSON.stringify(outsideColumnIssues));
    const outsideObject=structuredClone(config);outsideObject.relations[0].from.table='unapproved_table';
    assert.ok(JSON.parse(run(manifest,outsideObject).stdout).issues.some((issue:any)=>issue.code==='CONFIG_OBJECT_OUTSIDE_ALLOWLIST'));
    const unsafePath={...manifest,source:{...manifest.source,configPath:'../package.json'}};
    assert.ok(JSON.parse(run(unsafePath,config).stdout).issues.some((issue:any)=>issue.code==='INVALID_CONFIG_PATH'));
    const namespaceCollision=structuredClone(config);namespaceCollision.namespace='training_fixture';
    assert.ok(JSON.parse(run(manifest,namespaceCollision).stdout).issues.some((issue:any)=>issue.code==='CONFIG_NAMESPACE_COLLISION'));
    const sharedPhysicalDatabase=structuredClone(config);for(const table of Object.values<any>(sharedPhysicalDatabase.tables))table.db='training_fixture';sharedPhysicalDatabase.relations[0].from.db='training_fixture';sharedPhysicalDatabase.relations[0].to.db='training_fixture';
    assert.equal(JSON.parse(run(manifest,sharedPhysicalDatabase).stdout).status,'VALID');
    const wrongEndpointDatabase=structuredClone(config);wrongEndpointDatabase.relations[0].from.db='unrelated_database';
    assert.ok(JSON.parse(run(manifest,wrongEndpointDatabase).stdout).issues.some((issue:any)=>issue.code==='CONFIG_OBJECT_OUTSIDE_ALLOWLIST'));    const missingTableKeyDeclaration=structuredClone(config);delete missingTableKeyDeclaration.tables.child.keyColumns;
    assert.ok(JSON.parse(run(manifest,missingTableKeyDeclaration).stdout).issues.some((issue:any)=>issue.code==='MISSING_TABLE_KEY_COLUMNS'));
    const configDatabaseFallback=structuredClone(config);configDatabaseFallback.database=slug;for(const table of Object.values<any>(configDatabaseFallback.tables))delete table.db;
    assert.equal(JSON.parse(run(manifest,configDatabaseFallback).stdout).status,'VALID');    const unsupportedComposite=structuredClone(config);unsupportedComposite.tables.child.columns.push({name:'second_key',type:'string'});unsupportedComposite.tables.child.keyColumns=['parent_id','second_key'];unsupportedComposite.tables.parent.columns.push({name:'second_key',type:'string'});unsupportedComposite.tables.parent.keyColumns=['parent_id','second_key'];unsupportedComposite.relations[0].from.columns=['parent_id','second_key'];unsupportedComposite.relations[0].to.columns=['parent_id','second_key'];
    assert.ok(JSON.parse(run(manifest,unsupportedComposite).stdout).issues.some((issue:any)=>issue.code==='COMPOSITE_KEY_UNSUPPORTED_BY_ADAPTER'));
    const idCollision={...manifest,relationIds:['training_parent_child']};const collidingConfig=structuredClone(config);collidingConfig.relations[0].id='training_parent_child';
    assert.ok(JSON.parse(run(idCollision,collidingConfig).stdout).issues.some((issue:any)=>issue.code==='DUPLICATE_RELATION_ID'));
    const capabilityMismatch={...manifest,capabilities:[...manifest.capabilities,'BOUNDED_RELATION_PROBE'],capabilityBounds:{...manifest.capabilityBounds,BOUNDED_RELATION_PROBE:{probeLimit:50,maxRelationsPerRun:1,maxKeyColumns:1}}};
    assert.ok(JSON.parse(run(capabilityMismatch,config).stdout).issues.some((issue:any)=>issue.code==='CAPABILITY_UNSUPPORTED_BY_ADAPTER'));
    const traversal=spawnSync(process.execPath,[path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(ROOT,'src/cli.ts'),'universe','validate','--manifest','universes/../package.json'],{cwd:ROOT,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:missingEnv}});
    assert.equal(traversal.status,1);assert.match(traversal.stderr,/INVALID_MANIFEST_PATH/);
  }finally{
    for(const file of [absoluteManifest,absoluteConfig])if(fs.existsSync(file))fs.unlinkSync(file);
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});test('C2 runs GTFS, CHINOOK and a config-registered third-party fixture through the common evaluator', async () => {
  for (const alias of ['GTFS', 'CHINOOK', 'TRAINING_FIXTURE']) {
    const run = await evaluateLocalFixtureUniverse(alias);
    assert.equal(run.executionMode, 'LOCAL');
    assert.equal(run.dataOrigin, 'SYNTHETIC');
    assert.equal(run.results.length, 1);
    const result = run.results[0];
    assert.equal(result.probeStatus, 'COMPLETE');
    assert.equal(result.evidence.runRef.executionMode, 'LOCAL');
    assert.equal(result.evidence.runRef.dataOrigin, 'SYNTHETIC');
    const parity = evaluateRelation(result.contract, [result.evidence], { policyVersion: universeConfig(alias).relationPolicyVersion, minimumOverlapRatio: 1 });
    assert.deepEqual(result.decision, parity);
    assert.equal(result.decision.verdict, 'SOSTENIDA');
  }
});
test('C2 external CLI resolves fixture aliases and stable manifest IDs offline with evaluator parity', async () => {
  const scratch = fs.mkdtempSync(path.join(ROOT, '.concordia', 'local-fixture-cli-'));
  const preload = path.join(scratch, 'deny-network.mjs');
  const noEnv = path.join(scratch, 'must-not-load.env');
  fs.writeFileSync(preload, `import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
  try {
    const routes = [
      { requestedId: 'GTFS', configId: 'GTFS', manifestId: 'concordia.universe.gtfs' },
      { requestedId: 'concordia.universe.gtfs', configId: 'GTFS', manifestId: 'concordia.universe.gtfs' },
      { requestedId: 'CHINOOK', configId: 'CHINOOK', manifestId: 'concordia.universe.chinook' },
      { requestedId: 'TRAINING_FIXTURE', configId: 'TRAINING_FIXTURE', manifestId: 'vendor.universe.training-fixture' }
    ];
    for (const route of routes) {
      const output = execFileSync(process.execPath, [
        '--import', pathToFileURL(preload).href,
        path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'),
        path.join(ROOT, 'src/cli.ts'), 'universe', 'evaluate', '--universe', route.requestedId
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CONCORDIA_LOCAL_ENV_FILE: noEnv }
      });
      const cli = JSON.parse(output);
      assert.equal(cli.status, 'EVALUATED');
      assert.equal(cli.manifestId, route.manifestId);
      assert.equal(cli.universeId, route.requestedId);
      assert.equal(cli.configId, route.configId);
      assert.equal(cli.executionMode, 'LOCAL');
      assert.equal(cli.dataOrigin, 'SYNTHETIC');
      const direct = await evaluateLocalFixtureUniverse(route.configId);
      assert.deepEqual(cli.results.map((item: any) => ({ relationId: item.relationId, probeStatus: item.probeStatus, verdict: item.verdict, reasonCodes: item.reasonCodes })), direct.results.map(item => ({ relationId: item.relationId, probeStatus: item.probeStatus, verdict: item.decision.verdict, reasonCodes: item.decision.reasonCodes })));
    }
  const dispatched = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'src/cli.ts'), 'eval', '--universe', 'GTFS'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONCORDIA_LOCAL_ENV_FILE: noEnv } });
  const dispatchedResult = JSON.parse(dispatched);
  assert.equal(dispatchedResult.status,'EVALUATED');
  assert.equal(dispatchedResult.universeId,'GTFS');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

});
test('C2 U1 and U2 CLI eval replay typed evidence with the common evaluator offline',async()=>{
  const scratch=fs.mkdtempSync(path.join(ROOT,'.concordia','typed-cli-eval-'));
  const project=path.join(scratch,'project');
  const preload=path.join(scratch,'deny-network.mjs');
  const noEnv=path.join(scratch,'must-not-load.env');
  try{
    fs.mkdirSync(project,{recursive:true});
    for(const directory of ['src','config','universes','eval/cases'])fs.cpSync(path.join(ROOT,directory),path.join(project,directory),{recursive:true});
    fs.writeFileSync(preload,`import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
    const fixture=await evaluateLocalFixtureUniverse('GTFS');
    const typed=fixture.results[0];
    const thresholds=JSON.parse(fs.readFileSync(path.join(project,'config/thresholds.json'),'utf8'));
    const expected=evaluateRelation(typed.contract,[typed.evidence],{policyVersion:thresholds.relationPolicyVersion,minimumDistinctKeys:thresholds.minDistinctKeys,minimumOverlapRatio:thresholds.sustainedOverlap});
    const relation={relationId:typed.relationId,from:{table:'trips',column:'route_id'},to:{table:'routes',column:'route_id'},verdict:'SOSTENIDA',decision:typed.decision,relationContract:typed.contract,typedEvidence:typed.evidence,evidence:{relationContract:typed.contract,typedEvidence:typed.evidence,alerts:[]}};
    for(const id of ['U1','U2']){
      const cases=id==='U1'?{minCorrect:1,cases:[{id:'typed-parity',from:'trips.route_id',to:'routes.route_id',expected:[expected.verdict]}]}:{minCorrect:1,cases:[{id:'typed-parity',relationId:typed.relationId,expected:[expected.verdict],expectedByContractVersion:{[typed.contract.contractVersion]:[expected.verdict]}}]};
      fs.writeFileSync(path.join(project,'eval/cases',`${id}.json`),JSON.stringify(cases));
      fs.mkdirSync(path.join(project,'out',id),{recursive:true});
      fs.writeFileSync(path.join(project,'out',id,'relaciones.json'),JSON.stringify({relations:[relation]}));
      execFileSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),'eval','--universe',id],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:noEnv}});
      const result=JSON.parse(fs.readFileSync(path.join(project,'out',id,'eval.json'),'utf8'));
      assert.equal(result.results[0].actual,expected.verdict);
      assert.equal(result.results[0].pass,true);
      assert.equal(result.results[0].evaluationMode,'REPLAY');
      assert.equal(result.results[0].sourceExecutionMode,'LOCAL');
      assert.equal(result.results[0].sourceDataOrigin,'SYNTHETIC');
      assert.equal(result.results[0].evaluationPolicyVersion,thresholds.relationPolicyVersion);
      if(id==='U2'){
        assert.equal(result.results[0].expectationSource,'CONTRACT_VERSION');
        assert.equal(result.results[0].typedDecision.verdict,expected.verdict);
      }
    }
    const partialV2Contract={...typed.contract,contractVersion:'2.0'};
    const partialV2Evidence={...typed.evidence,contractVersion:'2.0',completeness:'PARTIAL'};
    const semanticExpectation={evaluationSet:'reason-gated-fixture',evaluationMeaning:'Synthetic policy regression only.',minCorrect:1,cases:[{id:'semantic-reason-required',relationId:typed.relationId,expected:['SOSTENIDA'],expectedByContractVersion:{'2.0':['INDETERMINADA']},expectedProvenanceByContractVersion:{'2.0':{reasonCodes:['identifier_space_or_namespace_unknown'],explanation:'Requires the evaluator semantic-unknown reason.'}}}]};
    fs.writeFileSync(path.join(project,'eval/cases/U2.json'),JSON.stringify(semanticExpectation));
    fs.writeFileSync(path.join(project,'out/U2/relaciones.json'),JSON.stringify({relations:[{...relation,relationContract:partialV2Contract,typedEvidence:partialV2Evidence}]}));
    const wrongCause=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),'eval','--universe','U2'],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:noEnv}});
    assert.equal(wrongCause.status,1);
    const rejectedCause=JSON.parse(fs.readFileSync(path.join(project,'out/U2/eval.json'),'utf8'));
    assert.equal(rejectedCause.results[0].actual,'INDETERMINADA');
    assert.deepEqual(rejectedCause.results[0].actualReasonCodes,['evidence_incomplete_or_truncated']);
    assert.equal(rejectedCause.results[0].expectationReasonCodesMet,false);
    assert.equal(rejectedCause.results[0].pass,false);

    const unmappedV3Contract={...typed.contract,contractVersion:'3.0'};
    const unmappedV3Evidence={...typed.evidence,contractVersion:'3.0'};
    fs.writeFileSync(path.join(project,'out/U2/relaciones.json'),JSON.stringify({relations:[{...relation,relationContract:unmappedV3Contract,typedEvidence:unmappedV3Evidence}]}));
    const unmappedRun=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),'eval','--universe','U2'],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:noEnv}});
    assert.equal(unmappedRun.status,1);
    const unmappedResult=JSON.parse(fs.readFileSync(path.join(project,'out/U2/eval.json'),'utf8'));
    assert.equal(unmappedResult.status,'INCOMPLETE');
    assert.equal(unmappedResult.expectationCoverage,'INCOMPLETE');
    assert.equal(unmappedResult.results[0].expectationSource,'UNCONFIGURED_CONTRACT_VERSION');
    assert.equal(unmappedResult.results[0].typedDecision.verdict,expected.verdict);
    assert.equal(unmappedResult.results[0].actual,expected.verdict);
    const legacyOnly={...relation,relationContract:undefined,typedEvidence:undefined,decision:undefined,evidence:{alerts:[]},verdict:'SOSTENIDA'};
    fs.writeFileSync(path.join(project,'out/U1/relaciones.json'),JSON.stringify({relations:[legacyOnly]}));
    const missingTyped=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src/cli.ts'),'eval','--universe','U1'],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:noEnv}});
    assert.equal(missingTyped.status,1);
    const incomplete=JSON.parse(fs.readFileSync(path.join(project,'out/U1/eval.json'),'utf8'));
    assert.equal(incomplete.status,'INCOMPLETE');
    assert.equal(incomplete.results[0].actual,'NOT_EVALUABLE');
    assert.equal(incomplete.results[0].legacyVerdict,'SOSTENIDA');
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
});
test('C2 fixture aliases and stable IDs share canonical contract, evidence and decision identity', async () => {
  for (const route of [
    { alias: 'GTFS', manifestId: 'concordia.universe.gtfs' },
    { alias: 'CHINOOK', manifestId: 'concordia.universe.chinook' },
    { alias: 'TRAINING_FIXTURE', manifestId: 'vendor.universe.training-fixture' }
  ]) {
    const aliasRun = await evaluateLocalFixtureUniverse(route.alias);
    const stableRun = await evaluateLocalFixtureUniverse(route.manifestId);
    assert.equal(aliasRun.universeId, route.alias);
    assert.equal(stableRun.universeId, route.manifestId);
    assert.equal(aliasRun.configId, stableRun.configId);
    assert.equal(aliasRun.results[0].contract.universeRef.universeId, route.manifestId);
    assert.equal(stableRun.results[0].contract.universeRef.universeId, route.manifestId);
    assert.deepEqual(stableRun.results, aliasRun.results);
  }
});

test('C2 external U3 eval replays typed evidence with current policy and never needs gold',()=>{
  const scratch=fs.mkdtempSync(path.join(ROOT,'.concordia','madi-typed-cli-'));
  const project=path.join(scratch,'project');
  const preload=path.join(scratch,'deny-network.mjs');
  const noEnv=path.join(scratch,'must-not-load.env');
  try{
    fs.mkdirSync(project,{recursive:true});
    fs.cpSync(path.join(ROOT,'src'),path.join(project,'src'),{recursive:true});
    fs.cpSync(path.join(ROOT,'config'),path.join(project,'config'),{recursive:true});
    fs.cpSync(path.join(ROOT,'universes'),path.join(project,'universes'),{recursive:true});
    const typed=evaluateSchemaCorrespondence({universeId:'U3',contractVersion:'1.0',relationId:'synthetic-schema-relation',source:{db:'synthetic_source',table:'companies',column:'name'},target:{dataset:'synthetic_target',column:'company_name'},candidate:'company_name',rule:'synthetic_fixture',distinctValues:4,observedRows:4,compatible:true,minDistinctKeys:1,policyVersion:'1.0',checkedAt:'2026-10-23T00:00:00.000Z',provenance:{executionMode:'LIVE',dataOrigin:'PUBLIC'}});
    const source={relationId:typed.contract.id,candidate:{status:'PROPOSED',target:'company_name'},decision:typed.decision,relationContract:typed.contract,typedEvidence:typed.evidence};
    const relationsPath=path.join(project,'out','U3','relaciones.json');
    fs.mkdirSync(path.dirname(relationsPath),{recursive:true});
    fs.writeFileSync(relationsPath,JSON.stringify({relations:[source]}));
    fs.writeFileSync(preload,`import http from 'node:http'; import https from 'node:https'; globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); }; for (const client of [http, https]) for (const method of ['request', 'get']) client[method] = () => { throw new Error('NETWORK_FORBIDDEN'); };\n`);
    const goldPath=path.join(project,'.concordia','data','madi','gold.json');
    assert.equal(fs.existsSync(goldPath),false);
    const output=execFileSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'node_modules/tsx/dist/cli.mjs'),path.join(project,'src','cli.ts'),'eval','--universe','U3'],{cwd:project,encoding:'utf8',env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:noEnv}});
    const match=output.match(/Eval U3 (\{[^\n]+\})/);
    assert.ok(match,output);
    const evaluated=JSON.parse(match[1]);
    const result=evaluated.results[0];
    assert.equal(evaluated.evaluationMode,'REPLAY');
    assert.equal(evaluated.evaluationPolicyVersion,'1.1');
    assert.equal(result.contractVersion,'1.0');
    assert.equal(result.sourceContractVersion,'1.0');
    assert.equal(result.sourceEvidenceContractVersion,'1.0');
    assert.equal(result.sourcePolicyVersion,'1.0');
    assert.equal(result.evaluationPolicyVersion,'1.1');
    assert.equal(result.evaluationMode,'REPLAY');
    assert.equal(result.sourceExecutionMode,'LIVE');
    assert.equal(result.sourceDataOrigin,'PUBLIC');
    assert.deepEqual(JSON.parse(fs.readFileSync(relationsPath,'utf8')),{relations:[source]});
    assert.equal(fs.existsSync(goldPath),false);
  }finally{
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});
