import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HMEM, type MemoryRecord } from '../hmem/index.ts';
import { readJson, writeJson, ROOT, SafeError } from '../runtime.ts';
import { normalizeKey, type NormalizationMode } from '../universe.ts';

export type ClaimObservation = { source: string; sourceVersion: string; observedAt: string; rule: string; requestIds: string[] };
export type Claim = { id: string; entity: string; attribute: string; value: string; source: string; confidence: number; entities: {name:string;type:string}[]; domain: string; requestIds: string[]; sourceVersion?: string; observedAt?: string; rule?: string; observations?: ClaimObservation[] };
export type Conflict = { id: string; entity: string; attribute: string; claimIds: string[]; status: 'queued'|'auto_resolved'|'human_resolved'; winner?: string; correction?: string; strategy: string; ledgerRef: number; note?: string };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Reconciler {
  readonly hmem: HMEM;
  readonly claims: Claim[];
  readonly conflicts: Conflict[];
  private file: string;
  constructor(readonly universeId = 'U1', dir = path.join(ROOT, '.concordia', universeId), readonly actor = 'concordia') {
    this.hmem = new HMEM({persistDir:dir,actor});
    this.file = path.join(dir, 'claims.json');
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {claims:[],conflicts:[]};
    this.claims = saved.claims; this.conflicts = saved.conflicts;
  }
  persist() { fs.writeFileSync(this.file, JSON.stringify({claims:this.claims,conflicts:this.conflicts},null,2)+'\n'); this.hmem.store.persist(); }
  addClaim(input: Omit<Claim,'id'|'domain'|'entities'>, correction = false, derivedFrom?: string[], provenanceLabel?:string) {
    const observedAt=input.observedAt??new Date().toISOString(),sourceVersion=input.sourceVersion??'unspecified',rule=input.rule??(correction?'human-correction':'bounded-evidence');
    const observation:ClaimObservation={source:input.source,sourceVersion,observedAt,rule,requestIds:[...input.requestIds]};
    const found = this.claims.find(c => c.entity === input.entity && c.attribute === input.attribute && c.value === input.value && c.source === input.source);
    if (found && !correction) {
      const observations=found.observations??[{source:found.source,sourceVersion:found.sourceVersion??'unspecified',observedAt:found.observedAt??new Date(0).toISOString(),rule:found.rule??'bounded-evidence',requestIds:[...found.requestIds]}];
      const key=(o:ClaimObservation)=>JSON.stringify([o.source,o.sourceVersion,o.rule,[...o.requestIds].sort()]);
      if(!observations.some(o=>key(o)===key(observation))){
        found.observations=[...observations,observation];
        this.hmem.ledger.log(found.id,'update',this.actor,{details:{event:'additional_observation_preserved_without_new_vote',...observation}});
        this.persist();
      }else if(!found.observations)found.observations=observations;
      return found;
    }
    const entities = [{name:input.entity,type:input.entity.startsWith('relation:')?'relationship':this.universeId==='U1'?'candidate-zone':'source-company'}];
    const memory = this.hmem.add({content:`${input.entity}.${input.attribute} = ${input.value}`,type:'factual',layer:'long_term',source:input.source,confidence:input.confidence,
      tags:['project:'+this.universeId,'tabular-claim'],derivedFrom,
      provenance:{origin:correction?'user_correction':'document',learnedAt:Date.now(),label:provenanceLabel??(correction?'Explicit review decision: '+this.actor:'Bounded SQL evidence; candidate entity alignment'),refs:input.requestIds}});
    // Upstream stores entity names as strings; typed entity metadata stays in
    // this adapter, without changing or falsely attributing the vendor code.
    this.hmem.store.update(memory.id,{domain:this.universeId,namespace:this.universeId+'/claims',entities:entities.map(e=>e.name)});
    const claim: Claim = {...input,sourceVersion,observedAt,rule,observations:[observation],id:memory.id,entities,domain:this.universeId}; this.claims.push(claim); this.persist(); return claim;
  }
  ingest(inventory: any, relations: any) {
    const cfg = readJson('config/reconcile.json');
    for (const r of relations.relations.filter((r:any)=>r.verdict==='SOSTENIDA')) {
      const confidence = cfg.relationBase+cfg.relationOverlapWeight*r.evidence.overlap.ratio+cfg.compatibleTypeWeight*Number(r.evidence.typeCompat.castable);
      this.addClaim({entity:'relation:'+r.relationId,attribute:'status',value:'SOSTENIDA',source:r.from.db+'.'+r.from.table,confidence,requestIds:r.evidence.queries.map((q:any)=>q.requestId),sourceVersion:r.evidence.sourceVersion??inventory.tables[r.from.table]?.sourceVersion??'unversioned',observedAt:r.evidence.utc,rule:r.rule??'bounded_key_overlap_and_compatible_types_labels'});
    }
    for(const r of relations.relations.filter((r:any)=>r.critic?.status==='DEGRADED')){
      const prior=this.claims.filter(c=>c.entity==='relation:'+r.relationId&&c.attribute==='status'&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy);
      if(!prior.length)continue;
      const counter=r.critic.counterprobes?.[0];
      const next=this.addClaim({entity:'relation:'+r.relationId,attribute:'status',value:'INDETERMINADA',source:r.from.db+'.'+r.from.table,confidence:0,requestIds:counter?.requestId?[counter.requestId]:[],sourceVersion:r.evidence?.sourceVersion??inventory.tables[r.from.table]?.sourceVersion??'unversioned',observedAt:counter?.utc??r.evidence?.utc,rule:'critic_downgrade: '+r.critic.reason},false,prior.map(c=>c.id),'critic');
      for(const old of prior){const prev=structuredClone(this.hmem.store.get(old.id)!);this.hmem.store.update(old.id,{supersededBy:next.id});this.hmem.ledger.log(old.id,'update',this.actor,{previousState:prev,newState:structuredClone(this.hmem.store.get(old.id)!),details:{event:'critic_downgrade',from:'SOSTENIDA',to:'INDETERMINADA',reason:r.critic.reason,supersededBy:next.id}});}
    }
    // The misleading catalog relation is intentionally retained as competing
    // claims about a candidate identity, never accepted as a verified join.
    const entitySources:any[]=this.universeId==='U1'?
      [['taxi_zones','LocationID',{zone:'name',borough:'borough'},'NY_TAXI','zone','integer'],['zones','zone_id',{zone_name:'name',borough:'borough'},'NY_TAXI','zone','integer']]:[];
    if(this.universeId==='U2')entitySources.push(['apple_submissions_raw','cik',{sic:'sic'},'SEC_DATA','company-cik','integer-pad10']);
    // Schema matching does not establish company identity: source-scoped only.
    if(this.universeId==='U3')for(const [table,t] of Object.entries<any>(inventory.tables)) {
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
          this.addClaim({entity:prefix+':'+id,attribute,value:String(value),source:db+'.'+table,confidence,requestIds:[t.sample.requestId],sourceVersion:t.sourceVersion??'unversioned',observedAt:t.sample.utc??t.sampleUtc??new Date().toISOString(),rule:'bounded-sample-attribute-evidence'});
        }
      }
    }
    this.detect(); return this.fichas();
  }
  detect() {
    const groups = new Map<string,Claim[]>();
    for (const c of this.claims.filter(c=>!c.entity.startsWith('relation:') && this.hmem.store.get(c.id)?.provenance.origin !== 'user_correction')) {
      const key = c.entity+'.'+c.attribute; groups.set(key,[...(groups.get(key)??[]),c]);
    }
    const cfg = readJson('config/reconcile.json');
    for (const alternatives of groups.values()) {
      if (new Set(alternatives.map(c=>c.value.trim().toLowerCase())).size < 2) continue;
      const ids = alternatives.map(c=>c.id).sort();
      const id = 'conflict-'+fingerprint([alternatives[0].entity,alternatives[0].attribute]).slice(0,16);
      if (this.conflicts.some(c=>c.id===id)) continue;
      const ranked = [...alternatives].sort((a,b)=>b.confidence-a.confidence);
      const decisionConfidence = ranked[0].confidence, margin = ranked[0].confidence-ranked[1].confidence;
      const automatic = decisionConfidence>=cfg.autoMinimumWinner && margin>=cfg.autoMinimumMargin;
      const detected = this.hmem.ledger.log(ids[0], 'conflict_detected', this.actor,{details:{conflictId:id,reason:'same-entity divergent attribute claims; candidate cross-catalog identity',alternatives:ids,decisionConfidence,margin}});
      const conflict: Conflict = {id,entity:alternatives[0].entity,attribute:alternatives[0].attribute,claimIds:ids,status:automatic?'auto_resolved':'queued',strategy:automatic?'evidence-confidence-margin':'human-required-comparable-evidence',ledgerRef:detected.timestamp};
      this.conflicts.push(conflict);
      if (automatic) this.resolve(conflict,ranked[0].id,false);
      else this.hmem.ledger.log(ids[0],'update',this.actor,{details:{event:'conflict_queued',conflictId:id,alternatives:ids}});
    }
    this.persist();
  }
  resolve(conflict: Conflict, claimId: string, human: boolean, note = '') {
    if (conflict.status === 'human_resolved' || conflict.winner) throw new SafeError('CONFLICT_ALREADY_RESOLVED');
    if (!conflict.claimIds.includes(claimId)) throw new SafeError('CLAIM_NOT_AN_ALTERNATIVE');
    const winner = this.claims.find(c=>c.id===claimId)!;
    const correction = human ? this.addClaim({...winner,confidence:readJson('config/reconcile.json').userCorrectionConfidence,source:'review:'+this.actor,requestIds:winner.requestIds},true,conflict.claimIds) : winner;
    for (const id of conflict.claimIds) {
      const prev = structuredClone(this.hmem.store.get(id)!);
      if (id !== correction.id) this.hmem.store.update(id,{supersededBy:correction.id});
      this.hmem.ledger.log(id,'conflict_resolved',this.actor,{previousState:prev,newState:structuredClone(this.hmem.store.get(id)!),details:{conflictId:conflict.id,winner:correction.id,selectedSourceClaim:claimId,mode:human?'explicit-review':'auto',note}});
    }
    conflict.status = human?'human_resolved':'auto_resolved'; conflict.winner=claimId; conflict.correction=human?correction.id:undefined; conflict.note=note; conflict.ledgerRef=Date.now(); this.persist();
  }
  fichas() {
    const entities = [...new Set(this.claims.filter(c=>!c.entity.startsWith('relation:')).map(c=>c.entity))];
    const fichas = entities.map(entity=>({entityType:this.universeId==='U1'?'candidate-zone':'source-company',entityKey:entity.slice(entity.indexOf(':')+1),identityWarning:this.universeId==='U1'?'Numeric id alignment across catalogs is a hypothesis; not a verified entity merge':'Source-scoped identity only; schema correspondence does not establish cross-source entity identity',attributes:[...new Set(this.claims.filter(c=>c.entity===entity).map(c=>c.attribute))].map(name=>{
      const claims = this.claims.filter(c=>c.entity===entity && c.attribute===name), conflict = this.conflicts.find(c=>c.entity===entity && c.attribute===name);
      const selected = conflict?.correction ?? conflict?.winner;
      return {name,value:conflict?.status==='queued'?null:(claims.find(c=>c.id===selected)??claims[0]).value,sources:claims.map(c=>c.source),claims,
        conflict:conflict?{...conflict,alternatives:claims.filter(c=>conflict.claimIds.includes(c.id))}:null};
    })}));
    return {utc:new Date().toISOString(),universe:this.universeId,fichas,claims:this.claims,conflicts:this.conflicts};
  }
  reinject() {
    const relation = this.hmem.query('relation SOSTENIDA '+this.universeId,{threshold:0,topN:100});
    const active=this.claims.filter(c=>c.entity.startsWith('relation:')&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy);
    const activeContext=active.map(c=>this.hmem.store.get(c.id)?.content).filter(Boolean).join('\n');
    const corrections = this.hmem.store.all().filter(m=>m.domain===this.universeId && m.provenance.origin==='user_correction' && !m.supersededBy);
    const alternatives=this.conflicts.map(conflict=>({conflictId:conflict.id,entity:conflict.entity,attribute:conflict.attribute,rule:conflict.strategy,status:conflict.status,claims:this.claims.filter(c=>conflict.claimIds.includes(c.id)).map(c=>({id:c.id,value:c.value,source:c.source,sourceVersion:c.sourceVersion,observedAt:c.observedAt,requestIds:c.requestIds,observations:c.observations,confidence:c.confidence}))}));
    return {context:activeContext+'\n[Preserved alternatives]\n'+JSON.stringify(alternatives)+'\n[Explicit corrections]\n'+corrections.map(c=>c.content).join('\n'),alternatives,trace:{...relation.trace,filteredRelationClaimIds:active.map(c=>c.id)},
      relationClaims:this.claims.filter(c=>c.entity.startsWith('relation:')&&c.value==='SOSTENIDA'&&!this.hmem.store.get(c.id)?.supersededBy).map(c=>c.entity.slice(9)),correctionIds:corrections.map(c=>c.id)};
  }
}
export function reconcile(universeId='U1') {
  const r = new Reconciler(universeId), out = r.ingest(readJson(`out/${universeId}/discovery.json`),readJson(`out/${universeId}/relaciones.json`));
  writeJson(`out/${universeId}/fichas.json`,out);
  const lines = ['# Fichas '+universeId,'','Claims de muestras guardadas; no son nuevas consultas. La identidad entre catálogos se mantiene como hipótesis.',''];
  for (const f of out.fichas) { lines.push('## Zona '+f.entityKey,'','| Campo | Valor elegido | Fuentes | Conflicto / estado |','|---|---|---|---|'); for (const a of f.attributes) lines.push(`| ${a.name} | ${a.value??'sin decisión'} | ${a.sources.join(', ')} | ${a.conflict?a.conflict.id+' / '+a.conflict.status:'sin conflicto'} |`); }
  fs.writeFileSync(path.join(ROOT,`out/${universeId}/fichas.md`),lines.join('\n')+'\n');
  writeJson(`evidence/reconcile-${universeId}.json`,{utc:out.utc,status:'PASS',source:'saved bounded SQL evidence',claimCount:r.claims.length,conflicts:r.conflicts,rule:readJson('config/reconcile.json')});
  console.log('Reconcile',universeId,'claims',r.claims.length,'queued',r.conflicts.filter(c=>c.status==='queued').length); return out;
}
