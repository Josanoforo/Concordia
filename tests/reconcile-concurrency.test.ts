import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Reconciler } from '../src/reconcile/index.ts';
import { resolveReviewDecision } from '../src/review.ts';
import { ROOT } from '../src/runtime.ts';
import { acquireReconcileWriterLock, atomicWriteFile, buildReconcileSnapshot, inspectReconcileWriterLock, readActiveReconcileSnapshot, reconcileSnapshotPath, recoverStaleReconcileWriterLock } from '../src/reconcile/persistence.ts';

const worker=path.join(path.dirname(fileURLToPath(import.meta.url)),'reconcile-concurrency-worker.ts');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFile(file:string,child?:ChildProcess){
  const start=Date.now();while(!fs.existsSync(file)){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error('WORKER_EXITED_BEFORE_BARRIER');if(Date.now()-start>15000)throw new Error('BARRIER_TIMEOUT '+JSON.stringify((child as any)?.captured?.()??{}));await delay(10);}
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function spawnWorker(args:string[]):ChildProcess{
  const child=spawn(process.execPath,['scripts/run-tsx.mjs',worker,...args],{cwd:ROOT,env:{...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(ROOT,'.concordia','no-such-local-env')},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout?.on('data',chunk=>stdout+=chunk);child.stderr?.on('data',chunk=>stderr+=chunk);(child as any).captured=()=>({stdout,stderr});return child;
}
async function waitExit(child:ChildProcess){
  let stdout='',stderr='';child.stdout?.on('data',chunk=>stdout+=chunk);child.stderr?.on('data',chunk=>stderr+=chunk);
  if(child.exitCode!==null)return {code:child.exitCode,stdout,stderr};
  return await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('WORKER_EXIT_TIMEOUT'));},15000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});
}
function fixture(){
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','b23-process-')),r=new Reconciler('U1',dir,'fixture');
  r.addClaim({entity:'zone:500',attribute:'name',value:'Alpha',source:'fixture.a',confidence:.5,requestIds:['a']});
  r.addClaim({entity:'zone:500',attribute:'name',value:'Beta',source:'fixture.b',confidence:.5,requestIds:['b']});r.detect();
  assert.equal(r.conflicts.length,1);assert.equal(r.conflicts[0].status,'queued');
  return {dir,conflict:r.conflicts[0],initialLedger:JSON.stringify(r.hmem.ledger.all())};
}
function gate(file:string){fs.writeFileSync(file,'go');}

test('B2/B3 two processes serialize review, return stale after lock release, and reload one complete commit',async t=>{
  const {dir,conflict,initialLedger}=fixture(),barriers=path.join(dir,'barriers');fs.mkdirSync(barriers);
  const aResult=path.join(barriers,'a.result'),bResult1=path.join(barriers,'b.first.result'),bResult2=path.join(barriers,'b.retry.result'),aReady=aResult+'.ready',bReady=bResult1+'.ready',aGate=path.join(barriers,'a.go'),bGate1=path.join(barriers,'b.first'),bGate2=path.join(barriers,'b.retry');
  const a=spawnWorker([dir,'resolve','mem-1',aGate,aResult,'','', 'process-a']);t.after(()=>a.kill());await waitFile(aReady,a);
  const b=spawnWorker([dir,'resolve','mem-2',bGate1,bResult1,bGate2,bResult2,'process-b']);t.after(()=>b.kill());await waitFile(bReady,b);
  assert.equal(JSON.parse(fs.readFileSync(aReady,'utf8')).version,conflict.version);assert.equal(JSON.parse(fs.readFileSync(bReady,'utf8')).version,conflict.version);
  const release=acquireReconcileWriterLock(dir,'U1');
  try{gate(bGate1);assert.equal((await waitFile(bResult1,b)).status,'WRITER_EXISTS');}finally{release();}
  gate(aGate);const aOutcome=await waitFile(aResult,a);assert.equal(aOutcome.status,'PASS');assert.equal((await waitExit(a)).code,0);
  gate(bGate2);assert.equal((await waitFile(bResult2,b)).status,'CONFLICT_VERSION_STALE');assert.equal((await waitExit(b)).code,0);
  const reloaded=new Reconciler('U1',dir,'reload');const confirmed=reloaded.conflicts.find(item=>item.id===conflict.id)!;
  assert.equal(confirmed.status,'human_resolved');assert.equal(confirmed.winner,'mem-1');assert.equal(confirmed.decisionHistory?.at(-1)?.actor,'process-a');assert.equal(confirmed.decisionHistory?.at(-1)?.reason,'process-a review reason');
  const initialEvents=JSON.parse(initialLedger);assert.deepEqual(reloaded.hmem.ledger.all().slice(0,initialEvents.length),initialEvents);assert.ok(reloaded.hmem.ledger.all().some(entry=>entry.actor==='process-a'&&entry.action==='conflict_resolved'));
});

test('B2/B3 a new alternative in another process invalidates stale review without losing either alternative',async t=>{
  const {dir,conflict}=fixture(),barriers=path.join(dir,'barriers');fs.mkdirSync(barriers);
  const aResult=path.join(barriers,'a.result'),bResult=path.join(barriers,'b.result'),aReady=aResult+'.ready',bReady=bResult+'.ready',aGate=path.join(barriers,'a.go'),bGate=path.join(barriers,'b.go');
  const alternative={entity:'zone:500',attribute:'name',value:'Gamma',source:'fixture.c',confidence:.5,requestIds:['c']};
  const a=spawnWorker([dir,'alternative',JSON.stringify(alternative),aGate,aResult,'','', 'process-alternative']);t.after(()=>a.kill());await waitFile(aReady,a);
  const b=spawnWorker([dir,'resolve','mem-1',bGate,bResult,'','', 'process-stale-review']);t.after(()=>b.kill());await waitFile(bReady,b);
  assert.equal(JSON.parse(fs.readFileSync(bReady,'utf8')).version,conflict.version);
  gate(aGate);assert.equal((await waitFile(aResult,a)).status,'PASS');assert.equal((await waitExit(a)).code,0);
  gate(bGate);assert.equal((await waitFile(bResult,b)).status,'CONFLICT_VERSION_STALE');assert.equal((await waitExit(b)).code,0);
  const reloaded=new Reconciler('U1',dir,'reload');const confirmed=reloaded.conflicts.find(item=>item.id===conflict.id)!;
  assert.equal(confirmed.status,'queued');assert.ok(confirmed.claimIds.some(id=>reloaded.claims.find(claim=>claim.id===id)?.value==='Gamma'));
  assert.equal(confirmed.claimIds.length,3);assert.ok(reloaded.hmem.ledger.all().some(entry=>entry.details?.event==='conflict_reopened'&&entry.details?.conflictId===conflict.id));
});

test('review decision helper preserves ledger prefix and reports actor, note, selection, and correction',()=>{
  const {dir,conflict,initialLedger}=fixture(),reviewer=new Reconciler('U1',dir,'review-actor'),current=reviewer.conflicts.find(item=>item.id===conflict.id)!;
  const result=resolveReviewDecision(reviewer,current,'mem-1','reviewed fixture evidence');
  assert.equal(result.conflict.status,'human_resolved');assert.equal(result.conflict.winner,'mem-1');assert.ok(result.conflict.correction);
  const history=result.conflict.decisionHistory?.at(-1);assert.equal(history?.actor,'review-actor');assert.equal(history?.reason,'reviewed fixture evidence');assert.equal(history?.winner,'mem-1');
  const ledger=reviewer.hmem.ledger.all();assert.equal(JSON.stringify(ledger.slice(0,JSON.parse(initialLedger).length)),initialLedger);assert.ok(ledger.some(entry=>entry.actor==='review-actor'&&entry.action==='conflict_resolved'&&entry.details?.selectedSourceClaim==='mem-1'&&entry.details?.reason==='reviewed fixture evidence'));
});
test('B2/B3 rejects semantically corrupt active snapshots even with recomputed checksums',()=>{
  const corruptions=[
    (snapshot:any)=>({...snapshot,memoryState:{...snapshot.memoryState,records:[...snapshot.memoryState.records,snapshot.memoryState.records[0]]}}),
    (snapshot:any)=>({...snapshot,memoryState:{...snapshot.memoryState,seq:0}}),
    (snapshot:any)=>({...snapshot,memoryState:{...snapshot.memoryState,records:snapshot.memoryState.records.map((record:any,index:number)=>index?record:{...record,namespace:'U2/claims'})}}),
    (snapshot:any)=>({...snapshot,claims:snapshot.claims.map((claim:any,index:number)=>index?claim:{...claim,id:'missing-memory'})}),
    (snapshot:any)=>({...snapshot,conflicts:snapshot.conflicts.map((conflict:any)=>({...conflict,claimIds:[...conflict.claimIds,'missing-claim']}))})
  ];
  for(const corrupt of corruptions){
    const {dir}=fixture(),current=readActiveReconcileSnapshot(dir,'U1')!;const {checksum:_checksum,...body}=current;const invalid=buildReconcileSnapshot(corrupt(body));
    atomicWriteFile(reconcileSnapshotPath(dir),Buffer.from(JSON.stringify(invalid,null,2)+'\n'));
    assert.throws(()=>readActiveReconcileSnapshot(dir,'U1'),/RECONCILE_SNAPSHOT_INVALID/);
    assert.throws(()=>new Reconciler('U1',dir,'should-reject'),/RECONCILE_SNAPSHOT_INVALID/);
  }
});

test('B2/B3 snapshot rename failure keeps the prior complete generation and projections',()=>{
  const {dir}=fixture(),reconciler=new Reconciler('U1',dir,'rename-failure'),snapshotFile=reconcileSnapshotPath(dir),beforeSnapshot=fs.readFileSync(snapshotFile),beforeClaims=fs.readFileSync(path.join(dir,'claims.json')),beforeState=fs.readFileSync(path.join(dir,'state.json')),beforeLedger=fs.readFileSync(path.join(dir,'ledger.jsonl'));
  const original=fs.renameSync;(fs as any).renameSync=(from:any,to:any)=>{if(path.resolve(String(to))===path.resolve(snapshotFile))throw new Error('injected snapshot rename failure');return(original as any)(from,to);};
  try{assert.throws(()=>reconciler.addClaim({entity:'zone:600',attribute:'name',value:'Delta',source:'fixture.d',confidence:.5,requestIds:['d']}),/injected snapshot rename failure/);}finally{(fs as any).renameSync=original;}
  assert.deepEqual(fs.readFileSync(snapshotFile),beforeSnapshot);assert.deepEqual(fs.readFileSync(path.join(dir,'claims.json')),beforeClaims);assert.deepEqual(fs.readFileSync(path.join(dir,'state.json')),beforeState);assert.deepEqual(fs.readFileSync(path.join(dir,'ledger.jsonl')),beforeLedger);
  assert.equal(new Reconciler('U1',dir,'after-failure').claims.some(claim=>claim.value==='Delta'),false);
});

test('B2/B3 an in-memory stale writer cannot persist over a newer generation',()=>{
  const {dir}=fixture(),stale=new Reconciler('U1',dir,'stale-writer'),writer=new Reconciler('U1',dir,'current-writer');
  stale.hmem.ledger.log('mem-1','read','stale-writer',{details:{query:'synthetic'}});
  writer.addClaim({entity:'zone:601',attribute:'name',value:'Epsilon',source:'fixture.e',confidence:.5,requestIds:['e']});
  assert.throws(()=>stale.persist(),/RECONCILE_SNAPSHOT_STALE/);
  const current=new Reconciler('U1',dir,'reload');assert.ok(current.claims.some(claim=>claim.value==='Epsilon'));assert.ok(!current.hmem.ledger.all().some(entry=>entry.actor==='stale-writer'));
});

test('B2/B3 snapshot fsync failure preserves the previous complete generation',()=>{
  const {dir}=fixture(),reconciler=new Reconciler('U1',dir,'fsync-failure'),snapshotFile=reconcileSnapshotPath(dir),before=fs.readFileSync(snapshotFile),beforeLedger=fs.readFileSync(path.join(dir,'ledger.jsonl'));
  const original=fs.fsyncSync;let calls=0;(fs as any).fsyncSync=(fd:any)=>{calls++;if(calls===2)throw new Error('injected snapshot fsync failure');return(original as any)(fd);};
  try{assert.throws(()=>reconciler.addClaim({entity:'zone:602',attribute:'name',value:'Zeta',source:'fixture.z',confidence:.5,requestIds:['z']}),/injected snapshot fsync failure/);}finally{(fs as any).fsyncSync=original;}
  assert.equal(calls,2);assert.deepEqual(fs.readFileSync(snapshotFile),before);assert.deepEqual(fs.readFileSync(path.join(dir,'ledger.jsonl')),beforeLedger);assert.equal(new Reconciler('U1',dir,'reload').claims.some(claim=>claim.value==='Zeta'),false);
});
test('B2/B3 projection failure leaves one complete active snapshot and recovers projections on next write',()=>{
  const {dir}=fixture(),reconciler=new Reconciler('U1',dir,'projection-failure'),claimsFile=path.join(dir,'claims.json'),beforeClaims=fs.readFileSync(claimsFile),snapshotFile=reconcileSnapshotPath(dir),original=fs.renameSync;
  (fs as any).renameSync=(from:any,to:any)=>{if(path.resolve(String(to))===path.resolve(claimsFile))throw new Error('injected claims projection rename failure');return(original as any)(from,to);};
  try{assert.throws(()=>reconciler.addClaim({entity:'zone:600',attribute:'name',value:'Delta',source:'fixture.d',confidence:.5,requestIds:['d']}),/RECONCILE_COMMIT_RECOVERY_REQUIRED/);}finally{(fs as any).renameSync=original;}
  const active=readActiveReconcileSnapshot(dir,'U1')!;assert.ok(active.claims.some(claim=>claim.value==='Delta'));assert.ok(active.memoryState.records.some(record=>record.content==='zone:600.name = Delta'));assert.ok(active.ledger.some(entry=>entry.action==='create'&&entry.newState?.content==='zone:600.name = Delta'));
  assert.deepEqual(fs.readFileSync(claimsFile),beforeClaims);const recovered=new Reconciler('U1',dir,'recover');assert.ok(recovered.claims.some(claim=>claim.value==='Delta'));recovered.detect();assert.notDeepEqual(fs.readFileSync(claimsFile),beforeClaims);assert.ok(readActiveReconcileSnapshot(dir,'U1')!.generation>active.generation-1);assert.ok(fs.existsSync(snapshotFile));
});
test('B2/B3 writer locks are scope-specific and abandoned locks require explicit confirmed recovery',()=>{
  const first=fs.mkdtempSync(path.join(ROOT,'.concordia','b23-lock-a-')),second=fs.mkdtempSync(path.join(ROOT,'.concordia','b23-lock-b-'));
  fs.mkdirSync(first,{recursive:true});fs.mkdirSync(second,{recursive:true});
  const release=acquireReconcileWriterLock(first,'U1');
  try{assert.throws(()=>new Reconciler('U1',first),/WRITER_EXISTS/);const independent=new Reconciler('U1',second);assert.equal(independent.claims.length,0);}finally{release();}
  const canonical=path.resolve(first),token='dead-owner-fixture',lockDir=path.join(ROOT,'.concordia','.reconcile-runtime',createHashForScope(canonical));fs.mkdirSync(lockDir,{recursive:true});
  const lockPath=path.join(lockDir,'.reconcile-writer.lock');fs.writeFileSync(lockPath,JSON.stringify({schemaVersion:1,token,pid:2147483647,hostname:os.hostname(),scope:canonical,universeId:'U1',acquiredAt:new Date(0).toISOString()})+'\n',{flag:'wx'});
  assert.throws(()=>new Reconciler('U1',first),/WRITER_EXISTS/);assert.equal(inspectReconcileWriterLock(first)?.token,token);
  recoverStaleReconcileWriterLock(first,token);assert.equal(inspectReconcileWriterLock(first),null);assert.equal(new Reconciler('U1',first).claims.length,0);
});
test('B2/B3 publish rejects ledger truncation, reorder, invalid state, and unsafe sequence before replacing the active snapshot',()=>{
  for(const mutate of [
    (r:Reconciler)=>r.hmem.ledger.restoreAll(r.hmem.ledger.all().slice(0,-1)),
    (r:Reconciler)=>r.hmem.ledger.restoreAll([...r.hmem.ledger.all()].reverse()),
    (r:Reconciler)=>{r.claims[0].domain='U2';},
    (r:Reconciler)=>{const memory=r.hmem.store.snapshotAll();r.hmem.store.restoreAll(memory.records,Number.MAX_SAFE_INTEGER+1);}
  ]){
    const {dir}=fixture(),writer=new Reconciler('U1',dir,'tamper-fixture'),snapshotFile=reconcileSnapshotPath(dir),before=fs.readFileSync(snapshotFile);
    mutate(writer);
    assert.throws(()=>writer.persist(),/LEDGER_APPEND_ONLY_VIOLATION|RECONCILE_SNAPSHOT_INVALID/);
    assert.deepEqual(fs.readFileSync(snapshotFile),before);
    const reloaded=new Reconciler('U1',dir,'after-tamper');assert.equal(reloaded.claims[0].domain,'U1');
  }
});

test('B2/B3 metadata scope keys preserve Windows aliases and distinguish case-sensitive scopes',()=>{
  const parent=fs.mkdtempSync(path.join(ROOT,'.concordia','b23-case-scope-')),first=path.join(parent,'ScopeA'),alias=path.join(parent,'scopea');fs.mkdirSync(first);
  if(process.platform==='win32'){
    assert.equal(reconcileSnapshotPath(first),reconcileSnapshotPath(alias));
  }else{
    fs.mkdirSync(alias);assert.notEqual(reconcileSnapshotPath(first),reconcileSnapshotPath(alias));
    const a=new Reconciler('U1',first,'case-a'),b=new Reconciler('U1',alias,'case-b');a.addClaim({entity:'zone:700',attribute:'name',value:'Only A',source:'a',confidence:.5,requestIds:['a']});
    assert.equal(b.claims.length,0);assert.notEqual(readActiveReconcileSnapshot(first,'U1')?.checksum,readActiveReconcileSnapshot(alias,'U1')?.checksum);
  }
});

test('B2/B3 legacy bootstrap rejects symlinked split-state files',t=>{
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','b23-legacy-symlink-')),external=path.join(dir,'external.json'),claims=path.join(dir,'claims.json');
  fs.writeFileSync(path.join(dir,'state-manifest.json'),JSON.stringify({schemaVersion:1,formatVersion:'1.0',universeId:'U1',namespace:'U1/claims',contractVersion:'1.0',policyVersion:'1.0',migrationState:'CURRENT'},null,2)+'\n');
  fs.writeFileSync(external,'[]\n');try{fs.symlinkSync(external,claims,'file');}catch(error:any){if(['EPERM','EACCES','ENOTSUP','EINVAL','UNKNOWN'].includes(error?.code)){t.skip('OS does not permit creating a file symlink');return;}throw error;}
  assert.throws(()=>new Reconciler('U1',dir,'symlink-bootstrap'),/RECONCILE_STATE_FILE_INVALID/);
});

test('B2/B3 ledger projection rejects a symlink before mutation',t=>{
  const {dir}=fixture(),snapshotFile=reconcileSnapshotPath(dir),before=fs.readFileSync(snapshotFile),ledger=path.join(dir,'ledger.jsonl'),saved=path.join(dir,'ledger.saved'),external=path.join(dir,'external-ledger.jsonl');
  fs.renameSync(ledger,saved);fs.writeFileSync(external,fs.readFileSync(saved));try{fs.symlinkSync(external,ledger,'file');}catch(error:any){fs.renameSync(saved,ledger);if(['EPERM','EACCES','ENOTSUP','EINVAL','UNKNOWN'].includes(error?.code)){t.skip('OS does not permit creating a file symlink');return;}throw error;}
  assert.throws(()=>new Reconciler('U1',dir,'symlink-projection').addClaim({entity:'zone:701',attribute:'name',value:'Rejected',source:'fixture',confidence:.5,requestIds:['x']}),/RECONCILE_STATE_FILE_INVALID/);
  assert.deepEqual(fs.readFileSync(snapshotFile),before);assert.deepEqual(fs.readFileSync(external),fs.readFileSync(saved));
});

function createHashForScope(scope:string){return createHash('sha256').update(path.resolve(scope).toLowerCase()).digest('hex');}
import { createHash } from 'node:crypto';