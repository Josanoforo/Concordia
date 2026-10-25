import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { createDependencyRef, assessEvidenceValidity, invalidateDependencies } from '../src/reconcile/freshness.ts';
import { makeStateManifest, migrateLegacyStateDirectory, planLegacyStateMigration } from '../src/reconcile/state-manifest.ts';
import { createHash } from 'node:crypto';
test('same entity and field with equal confidence queues; correction persists and ledger only appends',()=>{
  const dir = fs.mkdtempSync(path.join(ROOT,'.concordia','reconcile-test-'));
  const r = new Reconciler('U1',dir,'fixture-review');
  for (const [source,value] of [['NY_TAXI.taxi_zones','Airport'],['NY_TAXI.zones','Unrelated']]) r.addClaim({entity:'zone:1',attribute:'name',value,source,confidence:.7,requestIds:['fixture-request']});
  r.detect(); assert.equal(r.conflicts.length,1); assert.equal(r.conflicts[0].status,'queued');
  const ledger = fs.readFileSync(path.join(dir,'ledger.jsonl'),'utf8');
  r.resolve(r.conflicts[0],r.claims[0].id,true,'synthetic test, not a production decision',r.conflicts[0].version);
  assert.ok(fs.readFileSync(path.join(dir,'ledger.jsonl'),'utf8').startsWith(ledger));
  const reload = new Reconciler('U1',dir); assert.equal(reload.conflicts[0].status,'human_resolved');
  assert.equal(reload.hmem.store.get(reload.conflicts[0].correction!)?.provenance.origin,'user_correction');
  assert.ok(reload.reinject().correctionIds.length); assert.equal(reload.hmem.store.all().length,3);
});

test('L2-B manifest scopes persistent claims and refuses unmanifested legacy state',()=>{
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-scope-'));
  const first=new Reconciler('U1',path.join(dir,'u1'));
  first.addClaim({entity:'zone:9',attribute:'name',value:'A',source:'fixture.u1',confidence:.5,requestIds:[]});
  assert.throws(()=>new Reconciler('U2',path.join(dir,'u1')),/STATE_SCOPE_MISMATCH/);
  const legacyDir=path.join(dir,'legacy');fs.mkdirSync(legacyDir);fs.writeFileSync(path.join(legacyDir,'claims.json'),'{"claims":[],"conflicts":[]}');
  assert.throws(()=>new Reconciler('U1',legacyDir),/LEGACY_SCOPE_UNKNOWN/);
  assert.equal(fs.existsSync(path.join(legacyDir,'state-manifest.json')),false);
});

test('L2-B explicit migration is deterministic, owner checked and leaves source untouched',()=>{
  const claim={id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'};
  const memory={seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]};
  const input={sourceUniverse:'U1',targetUniverse:'U1',claims:[claim],conflicts:[],memoryState:memory};
  const first=planLegacyStateMigration(input),second=planLegacyStateMigration(input);
  assert.deepEqual(first,second);assert.equal(first.idMap['mem-1'],'mem-1');assert.equal(first.manifest.universeId,'U1');
  const prototypeId='__proto__';const prototypePlan=planLegacyStateMigration({sourceUniverse:'U1',targetUniverse:'U1',claims:[{...claim,id:prototypeId}],conflicts:[],memoryState:{seq:0,records:[{...memory.records[0],id:prototypeId}]}});assert.equal(Object.prototype.hasOwnProperty.call(prototypePlan.idMap,prototypeId),true);assert.equal(prototypePlan.idMap[prototypeId],prototypeId);
  assert.throws(()=>planLegacyStateMigration({...input,claims:[{...claim,domain:'UNKNOWN'}]}),/LEGACY_SCOPE_UNKNOWN/);
  assert.throws(()=>planLegacyStateMigration({...input,targetUniverse:'U2'}),/CROSS_UNIVERSE_MIGRATION_FORBIDDEN/);
});

test('L2-B migration preserves legacy conflicts without a version and links timestamp markers to ledger evidence', () => {
  const claims=[{id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'},{id:'mem-2',domain:'U1',entity:'zone:1',attribute:'name',value:'B',source:'fixture'}];
  const memoryState={seq:2,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'},{id:'mem-2',domain:'U1',namespace:'U1/claims',content:'zone:1.name = B',source:'fixture'}]};
  const conflict={id:'conflict-legacy',entity:'zone:1',attribute:'name',claimIds:['mem-1','mem-2'],status:'human_resolved',winner:'mem-2',strategy:'human-required',ledgerRef:44};
  const ledger=[
    {memoryId:'mem-1',action:'conflict_detected',actor:'fixture',timestamp:40,details:{conflictId:'conflict-legacy',alternatives:['mem-1','mem-2']}},
    {memoryId:'mem-2',action:'conflict_resolved',actor:'fixture',timestamp:45,details:{conflictId:'conflict-legacy',winner:'mem-2'}},
    {memoryId:'mem-2',action:'conflict_resolved',actor:'fixture',timestamp:47,details:{conflictId:'conflict-legacy',selectedSourceClaim:'mem-2',reason:'accepted'}}
  ];
  const planned=planLegacyStateMigration({sourceUniverse:'U1',targetUniverse:'U1',claims,conflicts:[conflict],memoryState,ledger});
  assert.deepEqual(planned.conflicts,[conflict]);assert.equal(planned.conflicts[0].ledgerRef,44);assert.equal(planned.counts.alternatives,2);assert.equal(planned.counts.ledgerEvents,3);assert.equal(planned.counts.ledgerDecisions,2);
  assert.throws(()=>planLegacyStateMigration({sourceUniverse:'U1',targetUniverse:'U1',claims,conflicts:[{...conflict,id:'different-conflict'}],memoryState,ledger}),/INVALID_LEDGER_REFERENCES/);
  const unrelatedLedger=ledger.map(entry=>entry.action==='conflict_resolved'?{...entry,details:{...entry.details,selectedSourceClaim:'mem-1',winner:'mem-1'}}:entry);
  assert.throws(()=>planLegacyStateMigration({sourceUniverse:'U1',targetUniverse:'U1',claims,conflicts:[conflict],memoryState,ledger:unrelatedLedger}),/INVALID_CONFLICT_LEDGER_REFERENCE/);
  assert.throws(()=>planLegacyStateMigration({sourceUniverse:'U1',targetUniverse:'U1',claims,conflicts:[],memoryState:{...memoryState,records:[{...memoryState.records[0],content:'wrong content'},memoryState.records[1]]}}),/CLAIM_MEMORY_CONTENT_MISMATCH/);
});

test('L2-B reads a legacy conflict snapshot without rewriting legacy bytes or timestamps',()=>{
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','b23-legacy-read-'));
  const claims=[{id:'mem-1',domain:'U1',entity:'zone:7',attribute:'name',value:'A',source:'fixture.a'},{id:'mem-2',domain:'U1',entity:'zone:7',attribute:'name',value:'B',source:'fixture.b'}];
  const conflicts=[{id:'conflict-legacy-read',entity:'zone:7',attribute:'name',claimIds:['mem-1','mem-2'],status:'queued',strategy:'human-required',ledgerRef:17}];
  const state={seq:2,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:7.name = A',source:'fixture.a'},{id:'mem-2',domain:'U1',namespace:'U1/claims',content:'zone:7.name = B',source:'fixture.b'}]};
  const ledger=[{memoryId:'mem-1',action:'create',actor:'fixture',timestamp:1}];
  fs.writeFileSync(path.join(dir,'state-manifest.json'),JSON.stringify(makeStateManifest('U1'),null,2)+'\n');
  fs.writeFileSync(path.join(dir,'claims.json'),JSON.stringify({claims,conflicts},null,4)+'\n');
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state,null,4)+'\n');
  fs.writeFileSync(path.join(dir,'ledger.jsonl'),JSON.stringify(ledger[0])+'\n');
  const files=['state-manifest.json','claims.json','state.json','ledger.jsonl'],before=Object.fromEntries(files.map(name=>{const file=path.join(dir,name),stat=fs.statSync(file);return[name,{bytes:fs.readFileSync(file),mtimeMs:stat.mtimeMs}];}));
  const first=new Reconciler('U1',dir),second=new Reconciler('U1',dir);
  assert.equal(first.conflicts[0].version,1);assert.equal(second.conflicts[0].id,conflicts[0].id);assert.equal(JSON.stringify(second.hmem.ledger.all()),JSON.stringify(ledger));
  const after=Object.fromEntries(files.map(name=>{const file=path.join(dir,name),stat=fs.statSync(file);return[name,{bytes:fs.readFileSync(file),mtimeMs:stat.mtimeMs}];}));assert.deepEqual(after,before);
});
test('L2-B directory migration writes a verified new target and preserves the legacy source',()=>{
  const root=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-migrate-')),source=path.join(root,'legacy'),target=path.join(root,'migrated');fs.mkdirSync(source);
  const claims=[{id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'}],state={seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]};
  const oldClaims=JSON.stringify({claims,conflicts:[]},null,2)+'\n',oldState=JSON.stringify(state,null,2)+'\n',oldLedger=JSON.stringify({memoryId:'mem-1',action:'create',actor:'fixture',timestamp:1})+'\n';
  fs.writeFileSync(path.join(source,'claims.json'),oldClaims);fs.writeFileSync(path.join(source,'state.json'),oldState);fs.writeFileSync(path.join(source,'ledger.jsonl'),oldLedger);
  const result=migrateLegacyStateDirectory(source,target,'U1');
  assert.equal(result.manifest.migrationState,'MIGRATED');assert.ok(fs.existsSync(path.join(target,'state-manifest.json')));
  const targetBeforeRead=Object.fromEntries(fs.readdirSync(target).sort().map(name=>{const file=path.join(target,name),stat=fs.statSync(file);return[name,{bytes:fs.readFileSync(file),mtimeMs:stat.mtimeMs}];}));
  const loaded=new Reconciler('U1',target);assert.equal(loaded.claims.length,1);assert.equal(loaded.hmem.store.all().length,1);assert.equal(loaded.hmem.ledger.all().length,1);
  const targetAfterRead=Object.fromEntries(fs.readdirSync(target).sort().map(name=>{const file=path.join(target,name),stat=fs.statSync(file);return[name,{bytes:fs.readFileSync(file),mtimeMs:stat.mtimeMs}];}));assert.deepEqual(targetAfterRead,targetBeforeRead);
  assert.equal(fs.readFileSync(path.join(source,'claims.json'),'utf8'),oldClaims);assert.equal(fs.readFileSync(path.join(source,'state.json'),'utf8'),oldState);assert.equal(fs.readFileSync(path.join(source,'ledger.jsonl'),'utf8'),oldLedger);
  assert.equal(result.status,'MIGRATED');assert.equal(result.receipt.counts.claims,1);assert.equal(result.receipt.counts.memoryRecords,1);assert.equal(result.receipt.counts.ledgerEvents,1);assert.equal(result.receipt.source.files['claims.json'].sha256,createHash('sha256').update(oldClaims).digest('hex'));
  const backup=path.join(ROOT,...result.receipt.sourceBackup.path.split('/'));assert.equal(fs.readFileSync(path.join(backup,'claims.json'),'utf8'),oldClaims);assert.equal(fs.readFileSync(path.join(backup,'state.json'),'utf8'),oldState);assert.equal(fs.readFileSync(path.join(backup,'ledger.jsonl'),'utf8'),oldLedger);const backupManifest=fs.readFileSync(path.join(backup,'source-backup-manifest.json'));assert.equal(createHash('sha256').update(backupManifest).digest('hex'),result.receipt.sourceBackup.manifestSha256);
  const snapshot=(dir:string)=>Object.fromEntries(fs.readdirSync(dir).sort().map(name=>[name,fs.readFileSync(path.join(dir,name))]));const beforeReuse=snapshot(target);
  const operationDir=path.dirname(backup);const operationSnapshot=()=>{const entries:string[]=[];const visit=(dir:string)=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),rel=path.relative(operationDir,file),stat=fs.statSync(file);entries.push(rel+':'+(stat.isDirectory()?'DIR':createHash('sha256').update(fs.readFileSync(file)).digest('hex')));if(stat.isDirectory())visit(file);}};visit(operationDir);return entries;};const operationBeforeReuse=operationSnapshot();
  const reused=migrateLegacyStateDirectory(source,target,'U1');assert.equal(reused.status,'REUSED');assert.deepEqual(reused.receipt,result.receipt);assert.deepEqual(snapshot(target),beforeReuse);assert.deepEqual(operationSnapshot(),operationBeforeReuse);
});

test('L2-B migration rejects target, receipt, backup, and source drift without repairing either side', () => {
  const root=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-reuse-')),source=path.join(root,'legacy'),target=path.join(root,'target');fs.mkdirSync(source);
  const claims=[{id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'}],state={seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]};
  const claimsText=JSON.stringify({claims,conflicts:[]},null,2)+'\n',stateText=JSON.stringify(state,null,2)+'\n';
  fs.writeFileSync(path.join(source,'claims.json'),claimsText);fs.writeFileSync(path.join(source,'state.json'),stateText);
  const migrated=migrateLegacyStateDirectory(source,target,'U1');
  const receiptPath=path.join(target,'migration-receipt.json'),receiptBytes=fs.readFileSync(receiptPath),targetStatePath=path.join(target,'state.json'),targetStateBytes=fs.readFileSync(targetStatePath);
  fs.appendFileSync(targetStatePath,' ');assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_TARGET_BYTES_MISMATCH/);fs.writeFileSync(targetStatePath,targetStateBytes);
  fs.writeFileSync(receiptPath,'{}');assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_RECEIPT_INVALID/);assert.equal(fs.readFileSync(receiptPath,'utf8'),'{}');
  fs.writeFileSync(receiptPath,receiptBytes);fs.rmSync(receiptPath);assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_RECEIPT_MISSING/);fs.writeFileSync(receiptPath,receiptBytes);
  const backup=path.join(ROOT,...migrated.receipt.sourceBackup.path.split('/')),backupClaims=fs.readFileSync(path.join(backup,'claims.json'));
  fs.appendFileSync(path.join(backup,'claims.json'),' ');assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_BACKUP_BYTES_MISMATCH/);fs.writeFileSync(path.join(backup,'claims.json'),backupClaims);
  fs.appendFileSync(path.join(source,'claims.json'),' ');assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_RECEIPT_IDENTITY_MISMATCH/);
  assert.equal(fs.readFileSync(receiptPath,'utf8'),receiptBytes.toString('utf8'));assert.equal(fs.readFileSync(path.join(source,'claims.json'),'utf8'),claimsText+' ');assert.equal(migrated.status,'MIGRATED');
});

test('L2-B REUSED validation rejects symlinked target files', t => {
  const root=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-target-symlink-')),source=path.join(root,'legacy'),target=path.join(root,'target');fs.mkdirSync(source);
  const claims=[{id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'}],state={seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]};
  fs.writeFileSync(path.join(source,'claims.json'),JSON.stringify({claims,conflicts:[]},null,2)+'\n');fs.writeFileSync(path.join(source,'state.json'),JSON.stringify(state,null,2)+'\n');migrateLegacyStateDirectory(source,target,'U1');
  const actual=path.join(target,'claims.json'),saved=path.join(target,'claims.real.json');fs.renameSync(actual,saved);
  try { fs.symlinkSync(saved,actual,'file'); }
  catch(error:any) { fs.renameSync(saved,actual);if(['EPERM','EACCES','ENOTSUP','EINVAL','UNKNOWN'].includes(error?.code)){t.skip('OS does not permit creating a file symlink');return;}throw error; }
  assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_FILE_INVALID/);
  fs.unlinkSync(actual);fs.renameSync(saved,actual);
});

test('L2-B REUSED validation rejects symlinked backup files', t => {
  const root=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-backup-symlink-')),source=path.join(root,'legacy'),target=path.join(root,'target');fs.mkdirSync(source);
  const claims=[{id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'}],state={seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]};
  fs.writeFileSync(path.join(source,'claims.json'),JSON.stringify({claims,conflicts:[]},null,2)+'\n');fs.writeFileSync(path.join(source,'state.json'),JSON.stringify(state,null,2)+'\n');const migrated=migrateLegacyStateDirectory(source,target,'U1');
  const backup=path.join(ROOT,...migrated.receipt.sourceBackup.path.split('/')),actual=path.join(backup,'claims.json'),saved=path.join(backup,'claims.real.json');fs.renameSync(actual,saved);
  try { fs.symlinkSync(saved,actual,'file'); }
  catch(error:any) { fs.renameSync(saved,actual);if(['EPERM','EACCES','ENOTSUP','EINVAL','UNKNOWN'].includes(error?.code)){t.skip('OS does not permit creating a file symlink');return;}throw error; }
  assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_BACKUP_FILE_INVALID/);
  fs.unlinkSync(actual);fs.renameSync(saved,actual);
});
test('L2-B migration validates ids, claim-memory links, H-MEM links, namespace evidence and conflict references', () => {
  const claim={id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'};
  const memory={seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]};
  const base={sourceUniverse:'U1',targetUniverse:'U1',claims:[claim],conflicts:[],memoryState:memory};
  assert.throws(()=>planLegacyStateMigration({...base,claims:[claim,{...claim}]}),/INVALID_OR_DUPLICATE_CLAIM/);
  assert.throws(()=>planLegacyStateMigration({...base,memoryState:{seq:1,records:[{id:'mem-2',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]}}),/CLAIM_MEMORY_LINK_INVALID/);
  assert.throws(()=>planLegacyStateMigration({...base,memoryState:{seq:1,records:[{...memory.records[0],domain:'UNKNOWN'}]}}),/LEGACY_SCOPE_UNKNOWN/);
  assert.throws(()=>planLegacyStateMigration({...base,memoryState:{seq:1,records:[{...memory.records[0],relatedTo:['missing']}]}}),/INVALID_HMEM_REFERENCES/);
  assert.throws(()=>planLegacyStateMigration({...base,targetNamespace:'U2/claims'}),/LEGACY_SCOPE_UNKNOWN/);
  assert.throws(()=>planLegacyStateMigration({...base,memoryState:{seq:0,records:memory.records}}),/MEMORY_SEQUENCE_BEHIND_IDS/);
  assert.throws(()=>planLegacyStateMigration({...base,ledger:[{memoryId:'mem-9',action:'delete',actor:'fixture',timestamp:9,previousState:{id:'mem-9'}}]}),/MEMORY_SEQUENCE_BEHIND_IDS/);
  const claims=[claim,{...claim,id:'mem-2',value:'B'}], records=[...memory.records,{id:'mem-2',domain:'U1',namespace:'U1/claims',content:'zone:1.name = B',source:'fixture'}];
  const conflict={id:'conflict-1',entity:'zone:1',attribute:'name',claimIds:['mem-1','missing'],status:'queued',strategy:'human-required',ledgerRef:1,version:1};
  assert.throws(()=>planLegacyStateMigration({...base,claims,conflicts:[conflict],memoryState:{seq:2,records}}),/INVALID_CONFLICT_REFERENCES/);
});

test('L2-B failed stage write rolls back only its stage and records a safe diagnostic', () => {
  const root=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-stage-failure-')),source=path.join(root,'legacy'),target=path.join(root,'target');fs.mkdirSync(source);
  const claimsText=JSON.stringify({claims:[{id:'mem-1',domain:'U1',entity:'zone:1',attribute:'name',value:'A',source:'fixture'}],conflicts:[]},null,2)+'\n';
  const stateText=JSON.stringify({seq:1,records:[{id:'mem-1',domain:'U1',namespace:'U1/claims',content:'zone:1.name = A',source:'fixture'}]},null,2)+'\n';
  fs.writeFileSync(path.join(source,'claims.json'),claimsText);fs.writeFileSync(path.join(source,'state.json'),stateText);
  const operationRoot=path.join(ROOT,'.concordia','migration-operations');const priorOperations=new Set(fs.existsSync(operationRoot)?fs.readdirSync(operationRoot):[]);
  const original=fs.openSync;let injected=false;
  (fs as any).openSync=(file:any,...args:any[])=>{if(!injected&&String(file).includes('.migration-')&&String(file).endsWith('state.json')){injected=true;throw new Error('synthetic private path failure');}return (original as any)(file,...args);};
  try { assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_IO_FAILED/); }
  finally { (fs as any).openSync=original; }
  assert.equal(injected,true);assert.equal(fs.existsSync(target),false);
  assert.equal(fs.readFileSync(path.join(source,'claims.json'),'utf8'),claimsText);assert.equal(fs.readFileSync(path.join(source,'state.json'),'utf8'),stateText);
  assert.equal(fs.readdirSync(root).some(name=>name.startsWith('target.migration-')),false);
  const originalFsync=fs.fsyncSync;let fsyncInjected=false;
  (fs as any).fsyncSync=(fd:any)=>{if(!fsyncInjected){fsyncInjected=true;throw new Error('synthetic fsync failure');}return (originalFsync as any)(fd);};
  try { assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_IO_FAILED/); } finally { (fs as any).fsyncSync=originalFsync; }
  assert.equal(fsyncInjected,true);assert.equal(fs.existsSync(target),false);assert.equal(fs.readdirSync(root).some(name=>name.startsWith('target.migration-')),false);
  assert.equal(fs.readFileSync(path.join(source,'claims.json'),'utf8'),claimsText);assert.equal(fs.readFileSync(path.join(source,'state.json'),'utf8'),stateText);
  const originalRename=fs.renameSync;(fs as any).renameSync=(from:any,to:any)=>{if(String(from).includes('.migration-'))throw new Error('synthetic rename failure');return (originalRename as any)(from,to);};
  try { assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),/MIGRATION_TARGET_INCOMPLETE:MIGRATION_IO_FAILED/); } finally { (fs as any).renameSync=originalRename; }
  assert.equal(fs.existsSync(target),false);assert.equal(fs.readFileSync(path.join(source,'claims.json'),'utf8'),claimsText);assert.equal(fs.readFileSync(path.join(source,'state.json'),'utf8'),stateText);
  const newOperations=fs.readdirSync(operationRoot).filter(name=>!priorOperations.has(name));
  const attempts=newOperations.flatMap(name=>{const dir=path.join(operationRoot,name,'attempts');return fs.existsSync(dir)?fs.readdirSync(dir).map(file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))):[];});
  assert.ok(attempts.some(item=>item.status==='FAILED'&&item.errorCode==='MIGRATION_IO_FAILED'));
});
test('L2-B directory migration rejects traversal, external, overlapping and reparse paths',()=>{
  const root=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-path-'));
  const safeSource=path.join(root,'source'),safeTarget=path.join(root,'target');fs.mkdirSync(safeSource);
  const reject=(source:string,target:string,pattern:RegExp)=>assert.throws(()=>migrateLegacyStateDirectory(source,target,'U1'),pattern);
  reject(safeSource,path.join(ROOT,'..','outside-migration-target'),/OUTSIDE_APPROVED_ROOT/);
  reject(path.join(ROOT,'..','outside-migration-source'),safeTarget,/OUTSIDE_APPROVED_ROOT/);
  reject(safeSource,safeSource,/SOURCE_EQUALS_TARGET/);
  reject(root,path.join(root,'nested-target'),/PATHS_OVERLAP/);
  reject(path.join(root,'nested-source'),root,/PATHS_OVERLAP/);
  const link=path.join(root,'source-link');
  try { fs.symlinkSync(safeSource,link,'junction'); reject(link,path.join(root,'linked-target'),/REPARSE_POINT_FORBIDDEN/); }
  catch (error) { if (error instanceof assert.AssertionError) throw error; }
});

test('L2-B material alternatives reopen a conflict and stale expected version cannot resolve it',()=>{
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','l2b-reopen-'));
  const r=new Reconciler('U1',dir,'fixture-review');
  const a=r.addClaim({entity:'zone:10',attribute:'name',value:'A',source:'fixture.a',confidence:.5,requestIds:['a']});
  const b=r.addClaim({entity:'zone:10',attribute:'name',value:'B',source:'fixture.b',confidence:.5,requestIds:['b']});
  r.detect();const conflict=r.conflicts[0],version1=conflict.version;
  const staleReviewer=new Reconciler('U1',dir,'stale-reviewer'),staleConflict=staleReviewer.conflicts[0];
  r.resolve(conflict,b.id,true,'selected b',version1);
  const resolvedVersion=conflict.version;
  assert.throws(()=>staleReviewer.resolve(staleConflict.id,a.id,true,'stale',version1),/CONFLICT_VERSION_STALE/);
  r.addClaim({entity:'zone:10',attribute:'name',value:'B',source:'fixture.b',confidence:.5,requestIds:['b-new'],sourceVersion:'v2'});
  r.detect();assert.equal(conflict.version,resolvedVersion);assert.equal(conflict.status,'human_resolved');
  const c=r.addClaim({entity:'zone:10',attribute:'name',value:'C',source:'fixture.c',confidence:.5,requestIds:['c']});
  r.detect();assert.equal(conflict.version,resolvedVersion+1);assert.equal(conflict.status,'queued');assert.equal(conflict.winner,undefined);
  assert.ok(conflict.decisionHistory?.some(decision=>decision.winner===b.id));
  const count=r.claims.length;for(let i=0;i<10;i++)r.detect();assert.equal(r.claims.length,count);assert.equal(r.conflicts.length,1);assert.ok(conflict.claimIds.includes(c.id));
});

test('L2-B freshness is independent of cache, preserves incomplete evidence and invalidates dependents only',()=>{
  const base={observedAt:'2026-01-01T00:00:00Z',checkedAt:'2026-01-01T00:00:00Z',sourceToken:null,sourceFingerprint:'f1',schemaFingerprint:'s1',contractFingerprint:'c1',normalizationFingerprint:'n1',completeness:'COMPLETE' as const,requestIds:['r1']};
  const fresh=assessEvidenceValidity(base,undefined,0,Date.parse(base.checkedAt));assert.equal(fresh.state,'CURRENT_FOR_CHECK');
  const changed=assessEvidenceValidity({...base,checkedAt:'2026-01-01T00:01:00Z',sourceFingerprint:'f2'},fresh,60_000,Date.parse('2026-01-01T00:01:00Z'));
  assert.equal(changed.state,'CURRENT_FOR_CHECK');assert.equal(changed.requiresReview,true);
  const incomplete=assessEvidenceValidity({...base,completeness:'PARTIAL',checkedAt:'2026-01-01T00:02:00Z'},fresh,0,Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(incomplete.state,'INCOMPLETE');
  const refs=[createDependencyRef('decision','decision',['evidence-1'],'v1'),createDependencyRef('report','output',['decision'],'v1'),createDependencyRef('unrelated','output',['evidence-2'],'v1')];
  assert.deepEqual(invalidateDependencies(refs,['evidence-1']).map(ref=>[ref.id,ref.state]),[['decision','STALE'],['report','STALE'],['unrelated','CURRENT']]);
});
test('same entity different attributes do not conflict; auto resolution requires evidence margin',()=>{
  const dir = fs.mkdtempSync(path.join(ROOT,'.concordia','reconcile-test-')); const r = new Reconciler('U1',dir);
  r.addClaim({entity:'zone:2',attribute:'name',value:'A',source:'fixture.a',confidence:.95,requestIds:['x']});
  r.addClaim({entity:'zone:2',attribute:'name',value:'B',source:'fixture.b',confidence:.5,requestIds:['y']});
  r.addClaim({entity:'zone:2',attribute:'borough',value:'C',source:'fixture.b',confidence:.5,requestIds:['z']});
  r.detect(); assert.equal(r.conflicts.length,1); assert.equal(r.conflicts[0].status,'auto_resolved');
  assert.ok(r.hmem.store.get(r.claims[1].id)?.supersededBy); assert.equal(r.hmem.store.all().length,3);
});

test('reinject preserves source/version/date/rule and alternatives without adding a support vote',()=>{
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','reconcile-test-')),r=new Reconciler('U1',dir,'fixture-reuse');
  const shared={entity:'zone:3',attribute:'name',confidence:.7,requestIds:['request-a'],sourceVersion:'taxi-zones-v1',observedAt:'2026-10-22T10:00:00Z',rule:'bounded-label-join'};
  const original=r.addClaim({...shared,value:'Astoria',source:'NY_TAXI.taxi_zones'});
  const revisedObservation=r.addClaim({...shared,value:'Astoria',source:'NY_TAXI.taxi_zones',requestIds:['request-a-v2'],sourceVersion:'taxi-zones-v2',observedAt:'2026-10-22T11:00:00Z'});
  assert.equal(revisedObservation.id,original.id);
  assert.equal(original.observations?.length,2);
  r.addClaim({...shared,value:'Other place',source:'NY_TAXI.zones',requestIds:['request-b'],sourceVersion:'zones-v1'});
  r.detect();
  const before=r.claims.length,first=r.reinject(),second=r.reinject();
  assert.equal(r.claims.length,before);
  assert.equal(r.addClaim({...shared,value:'Astoria',source:'NY_TAXI.taxi_zones',requestIds:['request-a-v2'],sourceVersion:'taxi-zones-v2',observedAt:'2026-10-22T11:00:00Z'}).id,original.id);
  assert.equal(r.claims.length,before);
  assert.equal(first.alternatives[0].claims.length,2);
  assert.ok(first.context.includes('NY_TAXI.taxi_zones'));
  assert.deepEqual({sourceVersion:original.sourceVersion,observedAt:original.observedAt,rule:original.rule},{sourceVersion:'taxi-zones-v1',observedAt:'2026-10-22T10:00:00Z',rule:'bounded-label-join'});
  assert.deepEqual(original.observations?.map(o=>({sourceVersion:o.sourceVersion,observedAt:o.observedAt,requestIds:o.requestIds})),[{sourceVersion:'taxi-zones-v1',observedAt:'2026-10-22T10:00:00Z',requestIds:['request-a']},{sourceVersion:'taxi-zones-v2',observedAt:'2026-10-22T11:00:00Z',requestIds:['request-a-v2']}]);
  assert.equal(first.alternatives[0].claims.find((c:any)=>c.id===original.id)?.observations?.length,2);
  assert.deepEqual(second.alternatives,first.alternatives);
});
