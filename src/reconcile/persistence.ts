import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, SafeError } from '../runtime.ts';
import { validateStateManifest, type StateManifest } from './state-manifest.ts';
import type { Claim, Conflict } from './index.ts';
import { isTrustedSustained } from './trusted-sustained.ts';
import type { LedgerEntry, MemoryRecord } from '../hmem/types.ts';

export interface ReconcileSnapshotBody {
  schemaVersion: 1;
  generation: number;
  universeId: string;
  namespace: string;
  manifest: StateManifest;
  claims: Claim[];
  conflicts: Conflict[];
  memoryState: { seq: number; records: MemoryRecord[] };
  ledger: LedgerEntry[];
}
export interface ReconcileSnapshot extends ReconcileSnapshotBody { checksum: string }
export interface WriterLockRecord { schemaVersion: 1; token: string; pid: number; hostname: string; scope: string; universeId: string; acquiredAt: string }

const snapshotName = 'reconcile-snapshot.json';
const lockName = '.reconcile-writer.lock';
const recoveryName = '.reconcile-writer-recovery.lock';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeHash = (scope: string) => {
  const canonical = path.resolve(scope);
  return createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
};
function controlDirectory(scope: string, create: boolean): string {
  const canonical=validateReconcileScope(scope),root=path.join(path.resolve(ROOT,'.concordia'),'.reconcile-runtime'),directory=path.join(root,scopeHash(canonical));
  for(const dir of [root,directory]){
    if(!fs.existsSync(dir)){if(!create)return directory;fs.mkdirSync(dir);}
    const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||!within(fs.realpathSync(dir),fs.realpathSync(path.resolve(ROOT,'.concordia'))))throw new SafeError('RECONCILE_CONTROL_PATH_INVALID');
  }
  return directory;
}
const within = (candidate: string, root: string) => { const rel=path.relative(path.resolve(root),path.resolve(candidate));return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel); };

export function validateReconcileScope(input: string): string {
  const approved = path.resolve(ROOT, '.concordia'), resolved = path.resolve(input);
  if (!within(resolved, approved)) throw new SafeError('STATE_SCOPE_OUTSIDE_APPROVED_ROOT');
  let current = approved;
  const approvedStat = fs.lstatSync(approved);
  if (!approvedStat.isDirectory() || approvedStat.isSymbolicLink()) throw new SafeError('STATE_SCOPE_REPARSE_POINT');
  for (const segment of path.relative(approved, resolved).split(path.sep).filter(Boolean)) {
    current=path.join(current,segment);
    if (fs.existsSync(current)) {
      const stat=fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SafeError('STATE_SCOPE_REPARSE_POINT');
      if (!within(fs.realpathSync(current),fs.realpathSync(approved))) throw new SafeError('STATE_SCOPE_OUTSIDE_APPROVED_ROOT');
    }
  }
  return resolved;
}

export function acquireReconcileWriterLock(scope: string, universeId: string): () => void {
  const canonical=validateReconcileScope(scope), file=path.join(controlDirectory(canonical,true),lockName), token=randomUUID();
  const record:WriterLockRecord={schemaVersion:1,token,pid:process.pid,hostname:os.hostname(),scope:canonical,universeId,acquiredAt:new Date().toISOString()};
  let fd:number;
  try { fd=fs.openSync(file,'wx',0o600); }
  catch(error:any) { if(error?.code==='EEXIST')throw new SafeError('WRITER_EXISTS');throw new SafeError('WRITER_LOCK_CREATE_FAILED'); }
  let identity:fs.Stats;
  try { fs.writeFileSync(fd,JSON.stringify(record)+'\n');fs.fsyncSync(fd);identity=fs.fstatSync(fd); }
  catch { try{fs.closeSync(fd);}catch{};try{if(fs.existsSync(file))fs.unlinkSync(file);}catch{};throw new SafeError('WRITER_LOCK_CREATE_FAILED'); }
  fs.closeSync(fd);
  let released=false;
  return () => {
    if(released)return;
    try {
      const now=fs.lstatSync(file),bytes=fs.readFileSync(file),actual=JSON.parse(bytes.toString('utf8')) as WriterLockRecord;
      if(now.dev!==identity.dev||now.ino!==identity.ino||actual.token!==token||actual.scope!==canonical)throw new SafeError('WRITER_LOCK_OWNERSHIP_LOST');
      fs.unlinkSync(file);released=true;
    } catch(error) { if(error instanceof SafeError)throw error;throw new SafeError('WRITER_LOCK_OWNERSHIP_LOST'); }
  };
}

export function inspectReconcileWriterLock(scope: string): WriterLockRecord | null {
  const canonical=validateReconcileScope(scope),directory=controlDirectory(canonical,false),file=path.join(directory,lockName);
  if(!fs.existsSync(directory)||!fs.existsSync(file))return null;
  const resolvedDirectory=fs.realpathSync(directory),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!within(fs.realpathSync(file),resolvedDirectory))throw new SafeError('WRITER_LOCK_INVALID');
  let record:WriterLockRecord;
  try{record=JSON.parse(fs.readFileSync(file,'utf8')) as WriterLockRecord;}catch{throw new SafeError('WRITER_LOCK_INVALID');}
  if(record.schemaVersion!==1||typeof record.token!=='string'||!Number.isSafeInteger(record.pid)||record.pid<1||record.hostname!==os.hostname()||record.scope!==canonical||typeof record.universeId!=='string'||typeof record.acquiredAt!=='string')throw new SafeError('WRITER_LOCK_INVALID');
  return record;
}

export function recoverStaleReconcileWriterLock(scope: string, expectedToken: string): void {
  const canonical=validateReconcileScope(scope),directory=controlDirectory(canonical,true),lock=path.join(directory,lockName),recovery=path.join(directory,recoveryName),guard=randomUUID();
  let guardFd:number;
  try{guardFd=fs.openSync(recovery,'wx',0o600);}catch(error:any){if(error?.code==='EEXIST')throw new SafeError('WRITER_RECOVERY_IN_PROGRESS');throw new SafeError('WRITER_RECOVERY_FAILED');}
  const guardRecord=JSON.stringify({guard,scope:canonical})+'\n';let guardIdentity:fs.Stats;
  try{fs.writeFileSync(guardFd,guardRecord);fs.fsyncSync(guardFd);guardIdentity=fs.fstatSync(guardFd);}
  catch{try{fs.closeSync(guardFd);}catch{};try{if(fs.existsSync(recovery)&&fs.readFileSync(recovery,'utf8')===guardRecord)fs.unlinkSync(recovery);}catch{};throw new SafeError('WRITER_RECOVERY_FAILED');}
  fs.closeSync(guardFd);
  try{
    const initial=inspectReconcileWriterLock(canonical);
    if(!initial||initial.token!==expectedToken)throw new SafeError('WRITER_LOCK_CHANGED');
    try{process.kill(initial.pid,0);throw new SafeError('WRITER_LOCK_OWNER_ALIVE');}
    catch(error:any){if(error instanceof SafeError)throw error;if(error?.code!=='ESRCH')throw new SafeError('WRITER_LOCK_OWNER_UNKNOWN');}
    const before=fs.lstatSync(lock),current=inspectReconcileWriterLock(canonical);
    if(!current||current.token!==expectedToken)throw new SafeError('WRITER_LOCK_CHANGED');
    const after=fs.lstatSync(lock);
    if(before.dev!==after.dev||before.ino!==after.ino)throw new SafeError('WRITER_LOCK_CHANGED');
    fs.unlinkSync(lock);
  }finally{
    try{const stat=fs.lstatSync(recovery),actual=JSON.parse(fs.readFileSync(recovery,'utf8'));if(stat.dev===guardIdentity.dev&&stat.ino===guardIdentity.ino&&actual.guard===guard&&actual.scope===canonical)fs.unlinkSync(recovery);}catch{}
  }
}

export function readScopedRegularFile(scope:string,name:string):Buffer|null {
  const canonical=validateReconcileScope(scope);
  if(name!==path.basename(name)||name==='.'||name==='..')throw new SafeError('RECONCILE_STATE_FILE_INVALID');
  const file=path.join(canonical,name);let stat:fs.Stats;
  try{stat=fs.lstatSync(file);}catch(error:any){if(error?.code==='ENOENT')return null;throw new SafeError('RECONCILE_STATE_FILE_INVALID');}
  if(!stat.isFile()||stat.isSymbolicLink())throw new SafeError('RECONCILE_STATE_FILE_INVALID');
  const realRoot=fs.realpathSync(canonical),realFile=fs.realpathSync(file);
  if(!within(realFile,realRoot))throw new SafeError('RECONCILE_STATE_FILE_INVALID');
  let fd:number;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));}catch{throw new SafeError('RECONCILE_STATE_FILE_INVALID');}
  try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino)throw new SafeError('RECONCILE_STATE_FILE_INVALID');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
export function buildReconcileSnapshot(body: ReconcileSnapshotBody): ReconcileSnapshot { return { ...body, checksum: hash(body) }; }
export function validateReconcileSnapshotContent(state:Pick<ReconcileSnapshotBody,'universeId'|'namespace'|'manifest'|'claims'|'conflicts'|'memoryState'|'ledger'>,options:{strictSustained?:boolean}={}):void {
  const invalid=()=>{throw new SafeError('RECONCILE_SNAPSHOT_INVALID');};
  // Strict scopes: a SOSTENIDA claim that declares a review state must be REVIEWED and carry its run id and receipt. Claims written before the gate carry no review state and are read as legacy (never trusted for reuse).
  if(options.strictSustained)for(const claim of state.claims)if(claim.entity?.startsWith('relation:')&&claim.attribute==='status'&&claim.value==='SOSTENIDA'&&claim.reviewState!==undefined&&!isTrustedSustained(claim))throw new SafeError('SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW');
  if(!validateStateManifest(state.manifest)||state.universeId!==state.manifest.universeId||state.namespace!==state.manifest.namespace)invalid();
  const claimsById=new Map<string,Claim>(),recordsById=new Map<string,MemoryRecord>();
  for(const claim of state.claims){if(!claim||typeof claim.id!=='string'||claimsById.has(claim.id)||claim.domain!==state.universeId||typeof claim.entity!=='string'||typeof claim.attribute!=='string'||typeof claim.value!=='string'||typeof claim.source!=='string')invalid();claimsById.set(claim.id,claim);}
  for(const record of state.memoryState.records){if(!record||typeof record.id!=='string'||recordsById.has(record.id)||record.domain!==state.universeId||record.namespace!==state.namespace)invalid();recordsById.set(record.id,record);}
  const deletedIds=new Set(state.ledger.filter(entry=>entry?.action==='delete'&&entry.previousState?.id===entry.memoryId).map(entry=>entry.memoryId));
  const knownIds=new Set([...recordsById.keys(),...deletedIds]);
  const sequences=[...knownIds].map(id=>/^mem-(\d+)$/.exec(id)).filter(Boolean).map(match=>Number(match![1]));
  if(!Number.isSafeInteger(state.memoryState.seq)||state.memoryState.seq<0||sequences.length&&state.memoryState.seq<Math.max(...sequences))invalid();
  for(const claim of state.claims){const record=recordsById.get(claim.id);if(!record||record.content!==`${claim.entity}.${claim.attribute} = ${claim.value}`||record.source!==claim.source)invalid();}
  for(const record of state.memoryState.records){for(const key of ['relatedTo','derivedFrom']){const refs=(record as any)[key];if(refs!==undefined&&(!Array.isArray(refs)||refs.some((id:unknown)=>typeof id!=='string'||!knownIds.has(id))))invalid();}for(const key of ['supersedes','supersededBy']){const ref=(record as any)[key];if(ref!==undefined&&(!ref||!knownIds.has(ref)))invalid();}}
  const conflictIds=new Set<string>();
  for(const conflict of state.conflicts){if(!conflict||typeof conflict.id!=='string'||conflictIds.has(conflict.id)||!Array.isArray(conflict.claimIds)||conflict.claimIds.length<2||!Number.isSafeInteger(conflict.version)||conflict.version<1||!Number.isSafeInteger(conflict.ledgerRef)||!['queued','auto_resolved','human_resolved'].includes(conflict.status))invalid();conflictIds.add(conflict.id);const alternatives=new Set(conflict.claimIds);if(alternatives.size!==conflict.claimIds.length)invalid();for(const id of alternatives){const claim=claimsById.get(id);if(!claim||claim.entity!==conflict.entity||claim.attribute!==conflict.attribute)invalid();}if(conflict.winner!==undefined&&!alternatives.has(conflict.winner))invalid();if(conflict.correction!==undefined&&!knownIds.has(conflict.correction))invalid();}
  for(const entry of state.ledger){if(!entry||typeof entry.memoryId!=='string'||!knownIds.has(entry.memoryId)||typeof entry.actor!=='string'||typeof entry.action!=='string'||!Number.isFinite(entry.timestamp))invalid();const details=entry.details;if(details!==undefined){if(!details||typeof details!=='object'||Array.isArray(details))invalid();if(details.conflictId!==undefined&&!state.conflicts.some(conflict=>conflict.id===details.conflictId))invalid();for(const key of ['winner','selectedSourceClaim','correction','supersededBy','priorDecision']){const id=(details as any)[key];if(id!==undefined&&id!==null&&(typeof id!=='string'||!knownIds.has(id)))invalid();}if(details.alternatives!==undefined&&(!Array.isArray(details.alternatives)||(details.alternatives as unknown[]).some(id=>typeof id!=='string'||!knownIds.has(id))))invalid();}}
}
export function readActiveReconcileSnapshot(scope: string, universeId?: string): ReconcileSnapshot | null {
  const canonical=validateReconcileScope(scope),directory=controlDirectory(canonical,false),file=path.join(directory,snapshotName);
  if(!fs.existsSync(directory)||!fs.existsSync(file))return null;
  const resolvedDirectory=fs.realpathSync(directory),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!within(fs.realpathSync(file),resolvedDirectory))throw new SafeError('RECONCILE_SNAPSHOT_INVALID');
  let snapshot:any;try{const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino||!within(fs.realpathSync(file),resolvedDirectory))throw new SafeError('RECONCILE_SNAPSHOT_INVALID');snapshot=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}catch{throw new SafeError('RECONCILE_SNAPSHOT_INVALID');}
  const {checksum,...body}=snapshot??{};
  if(body.schemaVersion!==1||!Number.isSafeInteger(body.generation)||body.generation<0||typeof body.universeId!=='string'||typeof body.namespace!=='string'||!body.manifest||!Array.isArray(body.claims)||!Array.isArray(body.conflicts)||!body.memoryState||!Number.isSafeInteger(body.memoryState.seq)||!Array.isArray(body.memoryState.records)||!Array.isArray(body.ledger)||typeof checksum!=='string'||hash(body)!==checksum||(universeId&&body.universeId!==universeId))throw new SafeError('RECONCILE_SNAPSHOT_INVALID');
  validateReconcileSnapshotContent(body);
  return snapshot as ReconcileSnapshot;
}
export function reconcileSnapshotPath(scope: string): string { return path.join(controlDirectory(scope,true),snapshotName); }
export function atomicWriteFile(file: string, bytes: Buffer): void {
  const directory=path.dirname(file),temp=path.join(directory,`.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let created=false;
  try{const fd=fs.openSync(temp,'wx',0o600);created=true;try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);created=false;}
  catch(error){if(created)try{fs.unlinkSync(temp);}catch{};throw error;}
}