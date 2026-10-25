import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HMEM, type MemoryRecord } from '../hmem/index.ts';
import { readJson, writeJson, ROOT, SafeError } from '../runtime.ts';
import { normalizeKey, type NormalizationMode } from '../universe.ts';
import { assertStateScope, makeStateManifest, type StateManifest } from './state-manifest.ts';
import { acquireReconcileWriterLock, atomicWriteFile, buildReconcileSnapshot, readActiveReconcileSnapshot, readScopedRegularFile, reconcileSnapshotPath, validateReconcileScope, validateReconcileSnapshotContent, type ReconcileSnapshot } from './persistence.ts';
import type { LedgerEntry } from '../hmem/types.ts';
import { assessConsumerInputVersions, consumerFreshnessSnapshot, type ConsumerFreshnessSnapshot } from './consumer-freshness.ts';

export type ClaimObservation = { source: string; sourceVersion: string; observedAt: string; rule: string; requestIds: string[]; /** Agent run that produced the observation; absent for legacy pipeline claims. */ runId?: string };
export type Claim = { id: string; entity: string; attribute: string; value: string; source: string; confidence: number; entities: {name:string;type:string}[]; domain: string; requestIds: string[]; sourceVersion?: string; observedAt?: string; rule?: string; runId?: string; observations?: ClaimObservation[] };
export type Conflict = { id: string; entity: string; attribute: string; claimIds: string[]; status: 'queued'|'auto_resolved'|'human_resolved'; winner?: string; correction?: string; strategy: string; ledgerRef: number; note?: string; version: number; versionFingerprint: string; decisionHistory?: { version: number; winner: string; correction?: string; actor: string; reason: string; at: number }[] };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pathWithinScope=(file:string,scope:string)=>{const relative=path.relative(path.resolve(scope),path.resolve(file));return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
export class Reconciler {
  /** In-memory H-MEM view; durable mutations go through this facade, and persist() is generation-CAS guarded. */
  readonly hmem: HMEM;
  readonly claims: Claim[] = [];
  readonly conflicts: Conflict[] = [];
  readonly manifest: StateManifest;
  private file: string;
  private scope: string;
  private generation = 0;
  private snapshotChecksum = '';
  constructor(readonly universeId = 'U1', dir = path.join(ROOT, '.concordia', universeId), readonly actor = 'concordia') {
    this.scope = validateReconcileScope(dir);
    fs.mkdirSync(this.scope, { recursive: true });
    this.scope = validateReconcileScope(this.scope);
    this.file = path.join(this.scope, 'claims.json');
    const release = acquireReconcileWriterLock(this.scope, universeId);
    try {
      const manifestPath = path.join(this.scope, 'state-manifest.json');
      if (!fs.existsSync(manifestPath) && (fs.existsSync(this.file) || fs.existsSync(path.join(this.scope, 'state.json')) || fs.existsSync(path.join(this.scope, 'ledger.jsonl')))) throw new SafeError('LEGACY_SCOPE_UNKNOWN');
      if(fs.existsSync(manifestPath))readScopedRegularFile(this.scope,'state-manifest.json');
      this.manifest = fs.existsSync(manifestPath) ? assertStateScope(this.scope, universeId) : makeStateManifest(universeId);
      if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2) + '\n', { flag: 'wx' });
      this.hmem = new HMEM({actor});
      const active = readActiveReconcileSnapshot(this.scope, universeId);
      if (active) {
        this.restoreSnapshot(active);
        if (JSON.stringify(active.manifest) !== JSON.stringify(this.manifest) || active.namespace !== this.manifest.namespace) throw new SafeError('STATE_SCOPE_MISMATCH');
      } else {
        const imported = this.readLegacyState();
        this.restoreComponents(imported.memoryState, imported.ledger);
        this.replaceRows(this.claims, imported.claims);
        this.replaceRows(this.conflicts, imported.conflicts.map(conflict => this.hydrateConflict(conflict, imported.claims)));
        this.validateLoadedState();
        this.publishSnapshot(0,false);
      }
    } finally { release(); }
  }

  private readLegacyState(): { claims: Claim[]; conflicts: Conflict[]; memoryState: {seq:number;records:MemoryRecord[]}; ledger: LedgerEntry[] } {
    let saved:any={claims:[],conflicts:[]};
    const claimsBytes=readScopedRegularFile(this.scope,'claims.json');
    if(claimsBytes!==null) { try { saved=JSON.parse(claimsBytes.toString('utf8')); } catch { throw new SafeError('INVALID_RECONCILE_STATE'); } }
    if(!Array.isArray(saved.claims)||!Array.isArray(saved.conflicts))throw new SafeError('INVALID_RECONCILE_STATE');
    let memoryState:any={seq:0,records:[]};const stateBytes=readScopedRegularFile(this.scope,'state.json');
    if(stateBytes!==null){try{memoryState=JSON.parse(stateBytes.toString('utf8'));}catch{throw new SafeError('INVALID_MEMORY_STATE_JSON');}}
    if(!memoryState||!Number.isSafeInteger(memoryState.seq)||memoryState.seq<0||!Array.isArray(memoryState.records))throw new SafeError('INVALID_MEMORY_STATE_JSON');
    const ledgerBytes=readScopedRegularFile(this.scope,'ledger.jsonl');let ledger:LedgerEntry[]=[];
    if(ledgerBytes!==null){try{ledger=ledgerBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as LedgerEntry);}catch{throw new SafeError('INVALID_LEDGER_JSON');}}
    return {claims:saved.claims,conflicts:saved.conflicts,memoryState,ledger};
  }
  private hydrateConflict(conflict:any, claims:Claim[]): Conflict {
    const value={...conflict,version:conflict.version??1,versionFingerprint:conflict.versionFingerprint??fingerprint((conflict.claimIds??[]).map((id:string)=>{const claim=claims.find(candidate=>candidate.id===id);return claim?[id,claim.entity,claim.attribute,claim.value,claim.source,claim.rule]:[id];}))};
    return value as Conflict;
  }
  private restoreComponents(memoryState:{seq:number;records:MemoryRecord[]},ledger:LedgerEntry[]): void {
    this.hmem.store.restoreAll(memoryState.records,memoryState.seq);
    this.hmem.ledger.restoreAll(ledger);
  }
  private replaceRows<T extends {id:string}>(target:T[],rows:T[]): void {
    const existing=new Map(target.map(row=>[row.id,row]));
    const next=rows.map(row=>{const old=existing.get(row.id);if(!old)return structuredClone(row);for(const key of Object.keys(old) as (keyof T)[])delete (old as any)[key];Object.assign(old,structuredClone(row));return old;});
    target.splice(0,target.length,...next);
  }
  private restoreSnapshot(snapshot:ReconcileSnapshot): void {
    this.validatePersistedContent(snapshot);
    this.restoreComponents(snapshot.memoryState,snapshot.ledger);
    this.replaceRows(this.claims,snapshot.claims);
    this.replaceRows(this.conflicts,snapshot.conflicts.map(conflict=>this.hydrateConflict(conflict,snapshot.claims)));
    this.generation=snapshot.generation;this.snapshotChecksum=snapshot.checksum;
  }
  private validateLoadedState(): void {
    this.validatePersistedContent({universeId:this.universeId,namespace:this.manifest.namespace,manifest:this.manifest,claims:this.claims,conflicts:this.conflicts,memoryState:this.hmem.store.snapshotAll(),ledger:[...this.hmem.ledger.all()]});
  }
  private validatePersistedContent(state:{universeId:string;namespace:string;manifest:StateManifest;claims:Claim[];conflicts:Conflict[];memoryState:{seq:number;records:MemoryRecord[]};ledger:LedgerEntry[]}): void {
    if(state.universeId!==this.universeId||state.namespace!==this.manifest.namespace||JSON.stringify(state.manifest)!==JSON.stringify(this.manifest))throw new SafeError('RECONCILE_SNAPSHOT_INVALID');
    validateReconcileSnapshotContent(state);
  }
  private validateLedgerAppendOnly(previous:LedgerEntry[],next:LedgerEntry[]): void {
    if(next.length<previous.length||previous.some((entry,index)=>JSON.stringify(entry)!==JSON.stringify(next[index])))throw new SafeError('LEDGER_APPEND_ONLY_VIOLATION');
  }
  private snapshotBody(generation:number) {
    return {schemaVersion:1 as const,generation,universeId:this.universeId,namespace:this.manifest.namespace,manifest:this.manifest,
      claims:structuredClone(this.claims),conflicts:structuredClone(this.conflicts),memoryState:this.hmem.store.snapshotAll(),ledger:structuredClone([...this.hmem.ledger.all()])};
  }
  private payloadChecksum(): string {
    return fingerprint({claims:this.claims,conflicts:this.conflicts,memoryState:this.hmem.store.snapshotAll(),ledger:this.hmem.ledger.all()});
  }
  private publishSnapshot(generation:number,project=true): ReconcileSnapshot {
    const snapshot=buildReconcileSnapshot(this.snapshotBody(generation));
    this.validatePersistedContent(snapshot);
    const active=readActiveReconcileSnapshot(this.scope,this.universeId);
    if(active)this.validateLedgerAppendOnly(active.ledger,snapshot.ledger);
    atomicWriteFile(reconcileSnapshotPath(this.scope),Buffer.from(JSON.stringify(snapshot,null,2)+'\n','utf8'));
    this.generation=snapshot.generation;this.snapshotChecksum=snapshot.checksum;
    if(project){try { this.writeCompatibilityViews(snapshot); }
    catch { throw new SafeError('RECONCILE_COMMIT_RECOVERY_REQUIRED'); }}
    return snapshot;
  }
  private writeProjectionFile(file:string,bytes:Buffer): void {
    if(fs.existsSync(file)){
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new SafeError('RECONCILE_PROJECTION_FILE_INVALID');
      if(fs.readFileSync(file).equals(bytes))return;
    }
    atomicWriteFile(file,bytes);
  }
  private writeCompatibilityViews(snapshot:ReconcileSnapshot): void {
    this.writeProjectionFile(this.file,Buffer.from(JSON.stringify({claims:snapshot.claims,conflicts:snapshot.conflicts},null,2)+'\n','utf8'));
    const memoryState={seq:snapshot.memoryState.seq,records:snapshot.memoryState.records};
    this.writeProjectionFile(path.join(this.scope,'state.json'),Buffer.from(JSON.stringify(memoryState,null,2)+'\n','utf8'));
    const ledgerFile=path.join(this.scope,'ledger.jsonl'),existingBytes=readScopedRegularFile(this.scope,'ledger.jsonl'),existing=existingBytes?.toString('utf8')??'';
    if(existing&&!existing.endsWith('\n'))throw new SafeError('LEDGER_PROJECTION_INCOMPLETE');
    let current:LedgerEntry[]=[];
    try{current=existing.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as LedgerEntry);}catch{throw new SafeError('LEDGER_PROJECTION_INVALID');}
    if(current.length>snapshot.ledger.length||current.some((entry,index)=>JSON.stringify(entry)!==JSON.stringify(snapshot.ledger[index])))throw new SafeError('LEDGER_PROJECTION_DIVERGED');
    const suffix=snapshot.ledger.slice(current.length).map(entry=>JSON.stringify(entry)+'\n').join('');
    if(suffix){
      const fd=fs.openSync(ledgerFile,existingBytes===null?'wx':'a',0o600);
      try{const opened=fs.fstatSync(fd),leaf=fs.lstatSync(ledgerFile),realFile=fs.realpathSync(ledgerFile);if(!leaf.isFile()||leaf.isSymbolicLink()||opened.dev!==leaf.dev||opened.ino!==leaf.ino||!pathWithinScope(realFile,this.scope))throw new SafeError('RECONCILE_STATE_FILE_INVALID');fs.writeFileSync(fd,suffix);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
  }
  private withWriterLock<T>(operation:()=>T): T {
    const release=acquireReconcileWriterLock(this.scope,this.universeId);
    try{return operation();}finally{release();}
  }
  private mutate<T>(operation:()=>T): T {
    return this.withWriterLock(()=>{
      const active=readActiveReconcileSnapshot(this.scope,this.universeId);
      if(!active)throw new SafeError('RECONCILE_SNAPSHOT_MISSING');
      this.restoreSnapshot(active);this.writeCompatibilityViews(active);this.validateLoadedState();
      const before=this.payloadChecksum();let result:T;
      try{result=operation();}
      catch(error){this.restoreSnapshot(active);throw error;}
      if(this.payloadChecksum()!==before){
        try{this.publishSnapshot(active.generation+1);}
        catch(error){const committed=readActiveReconcileSnapshot(this.scope,this.universeId);if(committed)this.restoreSnapshot(committed);throw error;}
      }
      return result;
    });
  }
  persist(): void {
    this.withWriterLock(()=>{
      const active=readActiveReconcileSnapshot(this.scope,this.universeId);
      if(!active)throw new SafeError('RECONCILE_SNAPSHOT_MISSING');
      if(active.generation!==this.generation||active.checksum!==this.snapshotChecksum)throw new SafeError('RECONCILE_SNAPSHOT_STALE');
      if(this.payloadChecksum()!==fingerprint({claims:active.claims,conflicts:active.conflicts,memoryState:active.memoryState,ledger:active.ledger})){this.validateLoadedState();this.validateLedgerAppendOnly(active.ledger,[...this.hmem.ledger.all()]);this.publishSnapshot(active.generation+1);}
    });
  }
  addClaim(input: Omit<Claim,'id'|'domain'|'entities'>, correction = false, derivedFrom?: string[], provenanceLabel?:string) { return this.mutate(()=>this.addClaimUnlocked(input,correction,derivedFrom,provenanceLabel)); }
  private addClaimUnlocked(input: Omit<Claim,'id'|'domain'|'entities'>, correction = false, derivedFrom?: string[], provenanceLabel?:string) {
    const observedAt=input.observedAt??new Date().toISOString(),sourceVersion=input.sourceVersion??'unspecified',rule=input.rule??(correction?'human-correction':'bounded-evidence');
    const observation:ClaimObservation={source:input.source,sourceVersion,observedAt,rule,requestIds:[...input.requestIds],...(input.runId?{runId:input.runId}:{})};
    const found = this.claims.find(c => c.entity === input.entity && c.attribute === input.attribute && c.value === input.value && c.source === input.source);
    if (found && !correction) {
      const observations=found.observations??[{source:found.source,sourceVersion:found.sourceVersion??'unspecified',observedAt:found.observedAt??new Date(0).toISOString(),rule:found.rule??'bounded-evidence',requestIds:[...found.requestIds]}];
      const key=(o:ClaimObservation)=>JSON.stringify(o.runId===undefined?[o.source,o.sourceVersion,o.rule,[...o.requestIds].sort()]:[o.source,o.sourceVersion,o.rule,[...o.requestIds].sort(),o.runId]);
      if(!observations.some(o=>key(o)===key(observation))){
        found.observations=[...observations,observation];
        this.hmem.ledger.log(found.id,'update',this.actor,{details:{event:'additional_observation_preserved_without_new_vote',...observation}});
      }else if(!found.observations)found.observations=observations;
      return found;
    }
    const entities = [{name:input.entity,type:input.entity.startsWith('relation:')?'relationship':this.universeId==='U1'?'candidate-zone':'source-company'}];
    const memory = this.hmem.add({content:`${input.entity}.${input.attribute} = ${input.value}`,type:'factual',layer:'long_term',source:input.source,confidence:input.confidence,
      tags:['project:'+this.universeId,'tabular-claim'],derivedFrom,
      provenance:{origin:correction?'user_correction':'document',learnedAt:Date.now(),label:(provenanceLabel??(correction?'Explicit review decision: '+this.actor:'Bounded SQL evidence; candidate entity alignment'))+(input.runId?` [run ${input.runId}]`:''),refs:input.requestIds}});
    // Upstream stores entity names as strings; typed entity metadata stays in
    // this adapter, without changing or falsely attributing the vendor code.
    this.hmem.store.update(memory.id,{domain:this.universeId,namespace:this.universeId+'/claims',entities:entities.map(e=>e.name)});
    const claim: Claim = {...input,sourceVersion,observedAt,rule,observations:[observation],id:memory.id,entities,domain:this.universeId}; this.claims.push(claim); return claim;
  }
  /** With `runId` (the agent path) every claim is stamped with the run that observed it, verdict drift supersedes earlier claims, and only relation claims are written. */
  ingest(inventory: any, relations: any, options: { runId?: string } = {}) { return this.mutate(()=>this.ingestUnlocked(inventory,relations,options)); }
  private ingestUnlocked(inventory: any, relations: any, options: { runId?: string } = {}) {
    const cfg = readJson('config/reconcile.json'), runId = options.runId;
    const add = (input: Omit<Claim,'id'|'domain'|'entities'>, correction = false, derivedFrom?: string[], label?: string) => this.addClaimUnlocked(runId?{...input,runId}:input,correction,derivedFrom,label);
    for (const r of relations.relations.filter((r:any)=>r.verdict==='SOSTENIDA')) {
      const confidence = cfg.relationBase+cfg.relationOverlapWeight*r.evidence.overlap.ratio+cfg.compatibleTypeWeight*Number(r.evidence.typeCompat.castable);
      add({entity:'relation:'+r.relationId,attribute:'status',value:'SOSTENIDA',source:r.from.db+'.'+r.from.table,confidence,requestIds:r.evidence.queries.map((q:any)=>q.requestId),sourceVersion:r.evidence.sourceVersion??inventory.tables[r.from.table]?.sourceVersion??'unversioned',observedAt:r.evidence.utc,rule:r.rule??'bounded_key_overlap_and_compatible_types_labels'});
    }
    for(const r of relations.relations.filter((r:any)=>r.critic?.status==='DEGRADED')){
      const prior=this.claims.filter(c=>c.entity==='relation:'+r.relationId&&c.attribute==='status'&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy);
      if(!prior.length)continue;
      const counter=r.critic.counterprobes?.[0];
      const next=add({entity:'relation:'+r.relationId,attribute:'status',value:'INDETERMINADA',source:r.from.db+'.'+r.from.table,confidence:0,requestIds:counter?.requestId?[counter.requestId]:[],sourceVersion:r.evidence?.sourceVersion??inventory.tables[r.from.table]?.sourceVersion??'unversioned',observedAt:counter?.utc??r.evidence?.utc,rule:'critic_downgrade: '+r.critic.reason},false,prior.map(c=>c.id),'critic');
      for(const old of prior){const prev=structuredClone(this.hmem.store.get(old.id)!);this.hmem.store.update(old.id,{supersededBy:next.id});this.hmem.ledger.log(old.id,'update',this.actor,{previousState:prev,newState:structuredClone(this.hmem.store.get(old.id)!),details:{event:'critic_downgrade',from:'SOSTENIDA',to:'INDETERMINADA',reason:r.critic.reason,supersededBy:next.id}});}
    }
    for(const r of relations.relations.filter((r:any)=>r.freshness?.state==='DEGRADADA')){
      const prior=this.claims.filter(c=>c.entity==='relation:'+r.relationId&&c.attribute==='status'&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy);
      if(!prior.length)continue;
      const requestIds=(r.evidence?.queries??[]).map((q:any)=>q.requestId).filter(Boolean);
      const next=add({entity:'relation:'+r.relationId,attribute:'status',value:'INDETERMINADA',source:r.from.db+'.'+r.from.table,confidence:0,requestIds,sourceVersion:r.evidence?.freshness?.sourceVersion??r.evidence?.sourceVersion??'unversioned',observedAt:r.evidence?.freshness?.sourceObservedAt??r.evidence?.utc,rule:'freshness_changed_requires_review'},false,prior.map(c=>c.id),'freshness-watcher');
      for(const old of prior){const prev=structuredClone(this.hmem.store.get(old.id)!);this.hmem.store.update(old.id,{supersededBy:next.id});this.hmem.ledger.log(old.id,'update',this.actor,{previousState:prev,newState:structuredClone(this.hmem.store.get(old.id)!),details:{event:'freshness_degraded',from:'SOSTENIDA',to:'INDETERMINADA',preservedHistoricalClaim:old.id,supersededBy:next.id,requestIds}});}
    }
    if(runId){
      // A run that no longer sustains a relation retires the earlier SOSTENIDA claim; the superseded claim and its run stay in the history.
      const handled=new Set<string>(relations.relations.filter((r:any)=>r.critic?.status==='DEGRADED'||r.freshness?.state==='DEGRADADA').map((r:any)=>r.relationId));
      for(const r of relations.relations.filter((r:any)=>r.verdict!=='SOSTENIDA'&&!handled.has(r.relationId))){
        const prior=this.claims.filter(c=>c.entity==='relation:'+r.relationId&&c.attribute==='status'&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy);
        if(!prior.length)continue;
        const requestIds=(r.evidence?.queries??[]).map((q:any)=>q.requestId).filter(Boolean);
        const next=add({entity:'relation:'+r.relationId,attribute:'status',value:String(r.verdict??'INDETERMINADA'),source:r.from.db+'.'+r.from.table,confidence:0,requestIds,sourceVersion:r.evidence?.sourceVersion??inventory.tables[r.from.table]?.sourceVersion??'unversioned',observedAt:r.evidence?.utc,rule:'verdict_changed_in_run: '+(r.rule??'unspecified')},false,prior.map(c=>c.id),'run-verdict-change');
        for(const old of prior){const prev=structuredClone(this.hmem.store.get(old.id)!);this.hmem.store.update(old.id,{supersededBy:next.id});this.hmem.ledger.log(old.id,'update',this.actor,{previousState:prev,newState:structuredClone(this.hmem.store.get(old.id)!),details:{event:'verdict_changed_in_run',from:'SOSTENIDA',to:String(r.verdict??'INDETERMINADA'),runId,supersededBy:next.id,requestIds}});}
      }
    }
    // The misleading catalog relation is intentionally retained as competing
    // claims about a candidate identity, never accepted as a verified join.
    const entitySources:any[]=runId?[]:this.universeId==='U1'?
      [['taxi_zones','LocationID',{zone:'name',borough:'borough'},'NY_TAXI','zone','integer'],['zones','zone_id',{zone_name:'name',borough:'borough'},'NY_TAXI','zone','integer']]:[];
    if(!runId&&this.universeId==='U2')entitySources.push(['apple_submissions_raw','cik',{sic:'sic'},'SEC_DATA','company-cik','integer-pad10']);
    // Schema matching does not establish company identity: source-scoped only.
    if(!runId&&this.universeId==='U3')for(const [table,t] of Object.entries<any>(inventory.tables)) {
      if(t.keyColumns?.[0])entitySources.push([table,t.keyColumns[0],Object.fromEntries(t.columns.filter((c:string)=>c!==t.keyColumns[0]).map((c:string)=>[c,c])),'MADI_COMPANIES','company-'+table,'text']);
    }
    for (const [table,key,fields,db,prefix,normalization] of entitySources) {
      const t = inventory.tables[table]; if (!t) continue;
      for (const row of t.sample.rows) {
        const contract=readJson<any>(`universes/${this.universeId==='U1'?'U1_ny_taxi':this.universeId==='U2'?'U2_companies':'U3_madi_companies'}.json`).normalizationContract;
        if(!contract?.modes?.[normalization as NormalizationMode])throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
        const id = normalizeKey(row[t.columns.indexOf(key)],normalization as NormalizationMode); if (id === null) continue;
        for (const [column,attribute] of Object.entries(fields as Record<string,string>)) {
          const value = row[t.columns.indexOf(column)]; if (value === null || value === undefined || value === '') continue;
          const nulls = t.sample.rows.filter((r:any[])=>r[t.columns.indexOf(column)] == null).length;
          const confidence = cfg.attributeBase+cfg.sampleQualityWeight*(1-nulls/t.sample.rows.length);
          add({entity:prefix+':'+id,attribute,value:String(value),source:db+'.'+table,confidence,requestIds:[t.sample.requestId],sourceVersion:t.sourceVersion??'unversioned',observedAt:t.sample.utc??t.sampleUtc??new Date().toISOString(),rule:'bounded-sample-attribute-evidence'});
        }
      }
    }
    this.detectUnlocked(); return this.fichas();
  }
  detect() { return this.mutate(()=>this.detectUnlocked()); }
  private detectUnlocked() {
    const groups = new Map<string,Claim[]>();
    for (const c of this.claims.filter(c=>!c.entity.startsWith('relation:') && this.hmem.store.get(c.id)?.provenance.origin !== 'user_correction')) {
      const key = c.entity+'.'+c.attribute; groups.set(key,[...(groups.get(key)??[]),c]);
    }
    const cfg = readJson('config/reconcile.json');
    for (const alternatives of groups.values()) {
      if (new Set(alternatives.map(c=>c.value.trim().toLowerCase())).size < 2) continue;
      const ids = alternatives.map(c=>c.id).sort();
      const id = 'conflict-'+fingerprint([alternatives[0].entity,alternatives[0].attribute]).slice(0,16);
      const prior = this.conflicts.find(c=>c.id===id);
      if (prior) {
        const material = fingerprint(ids.map(claimId => { const claim=this.claims.find(c=>c.id===claimId)!; return [claimId,claim.entity,claim.attribute,claim.value,claim.source,claim.rule]; }));
        if (material !== prior.versionFingerprint) {
          const previousWinner = prior.winner;
          if (previousWinner && !(prior.decisionHistory ?? []).some(decision => decision.winner === previousWinner)) {
            prior.decisionHistory = [...(prior.decisionHistory ?? []), { version: prior.version, winner: previousWinner, correction: prior.correction, actor: 'legacy-unknown', reason: 'legacy decision preserved during conflict reopening', at: prior.ledgerRef }];
          }
          prior.claimIds = ids; prior.version += 1; prior.versionFingerprint = material; prior.winner = undefined; prior.correction = undefined; prior.status = 'queued';
          prior.strategy = 'material-alternative-requires-review';
          this.hmem.ledger.log(ids[0], 'update', this.actor, { details: { event: 'conflict_reopened', conflictId: id, conflictVersion: prior.version, alternatives: ids, priorDecision: previousWinner ?? null } });
        }
        continue;
      }
      const ranked = [...alternatives].sort((a,b)=>b.confidence-a.confidence);
      const decisionConfidence = ranked[0].confidence, margin = ranked[0].confidence-ranked[1].confidence;
      const automatic = decisionConfidence>=cfg.autoMinimumWinner && margin>=cfg.autoMinimumMargin;
      const detected = this.hmem.ledger.log(ids[0], 'conflict_detected', this.actor,{details:{conflictId:id,reason:'same-entity divergent attribute claims; candidate cross-catalog identity',alternatives:ids,decisionConfidence,margin}});
      const versionFingerprint = fingerprint(ids.map(claimId => { const claim=this.claims.find(c=>c.id===claimId)!; return [claimId,claim.entity,claim.attribute,claim.value,claim.source,claim.rule]; }));
      const conflict: Conflict = {id,entity:alternatives[0].entity,attribute:alternatives[0].attribute,claimIds:ids,status:automatic?'auto_resolved':'queued',strategy:automatic?'evidence-confidence-margin':'human-required-comparable-evidence',ledgerRef:detected.timestamp,version:1,versionFingerprint};
      this.conflicts.push(conflict);
      if (automatic) this.resolveUnlocked(conflict,ranked[0].id,false);
      else this.hmem.ledger.log(ids[0],'update',this.actor,{details:{event:'conflict_queued',conflictId:id,alternatives:ids}});
    }
  }
  resolve(conflictOrId: Conflict | string, claimId: string, human: boolean, note = '', expectedConflictVersion?: number) {
    const suppliedVersion=typeof conflictOrId==='string'?undefined:conflictOrId.version;
    return this.mutate(()=>this.resolveUnlocked(conflictOrId,claimId,human,note,expectedConflictVersion,suppliedVersion));
  }
  private resolveUnlocked(conflictOrId: Conflict | string, claimId: string, human: boolean, note = '', expectedConflictVersion?: number, suppliedVersion?: number) {
    const conflict = typeof conflictOrId === 'string' ? this.conflicts.find(candidate => candidate.id === conflictOrId) : this.conflicts.find(candidate => candidate.id === conflictOrId.id);
    if (!conflict) throw new SafeError('CONFLICT_NOT_FOUND');
    if(suppliedVersion!==undefined&&suppliedVersion!==conflict.version)throw new SafeError('CONFLICT_VERSION_STALE');
    readScopedRegularFile(this.scope,'state-manifest.json');
    const currentManifest = assertStateScope(this.scope, this.universeId);
    if (currentManifest.namespace !== this.manifest.namespace) throw new SafeError('STATE_SCOPE_MISMATCH');
    if (human && expectedConflictVersion === undefined) throw new SafeError('EXPECTED_CONFLICT_VERSION_REQUIRED');
    if (expectedConflictVersion !== undefined && expectedConflictVersion !== conflict.version) throw new SafeError('CONFLICT_VERSION_STALE');
    if (!conflict.claimIds.includes(claimId)) throw new SafeError('CLAIM_NOT_AN_ALTERNATIVE');
    const winner = this.claims.find(c=>c.id===claimId)!;
    const correction = human ? this.addClaimUnlocked({...winner,confidence:readJson('config/reconcile.json').userCorrectionConfidence,source:'review:'+this.actor,requestIds:winner.requestIds},true,conflict.claimIds) : winner;
    const priorWinner = conflict.winner;
    if (priorWinner && !(conflict.decisionHistory ?? []).some(decision => decision.winner === priorWinner)) {
      conflict.decisionHistory = [...(conflict.decisionHistory ?? []), { version: conflict.version, winner: priorWinner, correction: conflict.correction, actor: 'legacy-unknown', reason: 'legacy decision superseded by explicit review', at: conflict.ledgerRef }];
    }
    for (const id of conflict.claimIds) {
      const prev = structuredClone(this.hmem.store.get(id)!);
      if (id !== correction.id) this.hmem.store.update(id,{supersededBy:correction.id});
      this.hmem.ledger.log(id,'conflict_resolved',this.actor,{previousState:prev,newState:structuredClone(this.hmem.store.get(id)!),details:{conflictId:conflict.id,winner:correction.id,selectedSourceClaim:claimId,mode:human?'explicit-review':'auto',note}});
    }
    const decidedAt=Date.now();
    conflict.decisionHistory=[...(conflict.decisionHistory??[]),{version:conflict.version,winner:claimId,correction:human?correction.id:undefined,actor:this.actor,reason:note,at:decidedAt}];
    conflict.status = human?'human_resolved':'auto_resolved'; conflict.winner=claimId; conflict.correction=human?correction.id:undefined; conflict.note=note; conflict.ledgerRef=decidedAt;
    const resolvedVersion=conflict.version++;
    this.hmem.ledger.log(correction.id,'conflict_resolved',this.actor,{details:{conflictId:conflict.id,conflictVersion:resolvedVersion,versionAfterDecision:conflict.version,selectedSourceClaim:claimId,correction:human?correction.id:null,reason:note,decidedAt}});
  }
  fichas(previousFreshness?: ConsumerFreshnessSnapshot, freshnessOptions: { mode?: 'RENDER' | 'REGENERATE'; now?: () => number; maxAgeMs?: number } = {}) {
    const entities = [...new Set(this.claims.filter(c=>!c.entity.startsWith('relation:')).map(c=>c.entity))];
    const fichas = entities.map(entity=>({entityType:this.universeId==='U1'?'candidate-zone':'source-company',entityKey:entity.slice(entity.indexOf(':')+1),identityWarning:this.universeId==='U1'?'Numeric id alignment across catalogs is a hypothesis; not a verified entity merge':'Source-scoped identity only; schema correspondence does not establish cross-source entity identity',attributes:[...new Set(this.claims.filter(c=>c.entity===entity).map(c=>c.attribute))].map(name=>{
      const claims = this.claims.filter(c=>c.entity===entity && c.attribute===name), conflict = this.conflicts.find(c=>c.entity===entity && c.attribute===name);
      const selected = conflict?.correction ?? conflict?.winner;
      return {name,value:conflict?.status==='queued'?null:(claims.find(c=>c.id===selected)??claims[0]).value,sources:claims.map(c=>c.source),claims,
        conflict:conflict?{...conflict,alternatives:claims.filter(c=>conflict.claimIds.includes(c.id))}:null};
    })}));
    const relationIds=this.claims.filter(claim=>claim.entity.startsWith('relation:')).map(claim=>claim.entity.slice('relation:'.length));
    const snapshot=consumerFreshnessSnapshot(this.universeId,relationIds,previousFreshness,freshnessOptions);
    const freshness=assessConsumerInputVersions(snapshot,this.claims.filter(claim=>claim.entity.startsWith('relation:')&&claim.attribute==='status').map(claim=>({relationId:claim.entity.slice('relation:'.length),verdict:claim.value})));
    return {utc:new Date().toISOString(),universe:this.universeId,fichas,claims:this.claims,conflicts:this.conflicts,freshness};
  }
  reinject() { return this.mutate(()=>this.reinjectUnlocked()); }
  private reinjectUnlocked() {
    const relation = this.hmem.query('relation SOSTENIDA '+this.universeId,{threshold:0,topN:100});
    const active=this.claims.filter(c=>c.entity.startsWith('relation:')&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy);
    const activeContext=active.map(c=>this.hmem.store.get(c.id)?.content).filter(Boolean).join('\n');
    const corrections = this.hmem.store.all().filter(m=>m.domain===this.universeId && m.provenance.origin==='user_correction' && !m.supersededBy);
    const alternatives=this.conflicts.map(conflict=>({conflictId:conflict.id,entity:conflict.entity,attribute:conflict.attribute,rule:conflict.strategy,status:conflict.status,claims:this.claims.filter(c=>conflict.claimIds.includes(c.id)).map(c=>({id:c.id,value:c.value,source:c.source,sourceVersion:c.sourceVersion,observedAt:c.observedAt,requestIds:c.requestIds,observations:c.observations,confidence:c.confidence}))}));
    return {context:activeContext+'\n[Preserved alternatives]\n'+JSON.stringify(alternatives)+'\n[Explicit corrections]\n'+corrections.map(c=>c.content).join('\n'),alternatives,trace:{...relation.trace,filteredRelationClaimIds:active.map(c=>c.id)},
      relationClaims:this.claims.filter(c=>c.entity.startsWith('relation:')&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy).map(c=>c.entity.slice(9)),correctionIds:corrections.map(c=>c.id)};
  }
}
export function fichasMarkdown(out:any):string {
  const lines=['# Fichas '+out.universe,'','Claims de muestras guardadas; no son nuevas consultas. La identidad entre catálogos se mantiene como hipótesis.',''];
  for(const f of out.fichas??[]){lines.push('## Zona '+f.entityKey,'','| Campo | Valor elegido | Fuentes | Conflicto / estado |','|---|---|---|---|');for(const a of f.attributes)lines.push(`| ${a.name} | ${a.value??'sin decisión'} | ${a.sources.join(', ')} | ${a.conflict?a.conflict.id+' / '+a.conflict.status:'sin conflicto'} |`);}
  lines.push('','## Frescura y dependencias','',`Estado general: ${out.freshness?.state??'UNKNOWN'}.`);
  for(const item of out.freshness?.dependencies??[])lines.push(`- ${item.relationId}: ${item.state}; contract ${item.contractVersion??'UNKNOWN'}; decision ${item.decisionRef??'UNKNOWN'}; policy ${item.policyVersion??'UNKNOWN'}; attempt ${item.attemptRef??'UNKNOWN'}; checkedAt ${item.checkedAt??'UNKNOWN'}.`);
  return lines.join('\n')+'\n';
}
export function reconcile(universeId='U1') {
  const priorFile=path.join(ROOT,`out/${universeId}/fichas.json`);let previousFreshness:ConsumerFreshnessSnapshot|undefined;
  if(fs.existsSync(priorFile)){try{previousFreshness=JSON.parse(fs.readFileSync(priorFile,'utf8')).freshness;}catch{previousFreshness=undefined;}}
  const r=new Reconciler(universeId);r.ingest(readJson(`out/${universeId}/discovery.json`),readJson(`out/${universeId}/relaciones.json`));const out=r.fichas(previousFreshness,{mode:'REGENERATE'});
  writeJson(`out/${universeId}/fichas.json`,out);
  fs.writeFileSync(path.join(ROOT,'out',universeId,'fichas.md'),fichasMarkdown(out));
  writeJson(`evidence/reconcile-${universeId}.json`,{utc:out.utc,status:'PASS',source:'saved bounded SQL evidence',claimCount:r.claims.length,conflicts:r.conflicts,rule:readJson('config/reconcile.json')});
  console.log('Reconcile',universeId,'claims',r.claims.length,'queued',r.conflicts.filter(c=>c.status==='queued').length); return out;
}