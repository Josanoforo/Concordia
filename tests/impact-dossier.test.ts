import test from 'node:test';
import assert from 'node:assert/strict';
import { computeImpacts } from '../src/impact.ts';
import { buildDossier, evidenceConfidence } from '../src/usl/dossier.ts';
import { reportHtml } from '../src/report/index.ts';
const source={db:'SYNTH',table:'reference',column:'id'},target={db:'SYNTH',table:'other',column:'id'};
const inventory={tables:{reference:{labels:['label']},other:{labels:['label']}}};
function misleading(rows=3){return {relationId:'synthetic_labels',from:source,to:target,verdict:'ENGAÑOSA',rule:'shared_keys_conflicting_labels',evidenceId:'synthetic_labels',evidence:{utc:'2026-01-01',status:'PASS',queries:[{requestId:'synth-a',utc:'2026-01-01',rows:Array.from({length:rows},(_,i)=>[String(i),'Right '+i])},{requestId:'synth-b',utc:'2026-01-01',rows:Array.from({length:rows},(_,i)=>[String(i),'Wrong '+i])}],overlap:{matched:rows,probed:rows,ratio:1},labelAgreement:{agree:0,compared:rows,ratio:0},typeCompat:{castable:true},alerts:[]}};}
const cfg={relationBase:.5,relationOverlapWeight:.25,compatibleTypeWeight:.1},thresholds={minDistinctKeys:3,sustainedOverlap:.8};
test('impact performs bounded client join, counts source records and keeps references without inventing trips',()=>{
  const impacts=computeImpacts([misleading(30)],inventory),impact=impacts[0];
  assert.equal(impact.sample,20);assert.equal(impact.misattributed,20);assert.equal(impact.examples.length,3);assert.equal(impact.sqlCalls,0);assert.equal(impact.generations,0);
  assert.deepEqual(impact.examples[0],{key:'0',wrong:'Wrong 0',right:'Right 0'});assert.ok(impact.sentence.includes('No es un conteo de viajes'));assert.deepEqual(impact.requestIds,['synth-a','synth-b']);
});
test('missing labels cannot become a fabricated zero-error claim; unmatched labels are not misattributions',()=>{
  const relation=misleading();assert.equal(computeImpacts([relation],{tables:{}})[0].misattributed,null);
  relation.evidence.queries[1].rows=[];const i=computeImpacts([relation],inventory)[0];assert.equal(i.unmatched,3);assert.equal(i.misattributed,0);
});
test('CIK literal mismatch loses one link and is not mislabeled as another company',()=>{
  const wrong:any={...misleading(1),relationId:'synthetic_cik_literal',verdict:'INDETERMINADA',normalization:'text'};
  wrong.evidence={...wrong.evidence,labelAgreement:undefined,overlap:{matched:0,probed:1,ratio:0},queries:[{requestId:'literal-a',utc:'2026-01-01',rows:[['12345']]},{requestId:'literal-b',utc:'2026-01-01',rows:[]}]};
  const right={...wrong,relationId:'synthetic_cik_normalized',verdict:'SOSTENIDA',normalization:'integer-pad10',evidence:{...wrong.evidence,overlap:{matched:1,probed:1,ratio:1},queries:[wrong.evidence.queries[0],{requestId:'normal-b',utc:'2026-01-01',rows:[['0000012345']]}]}};
  const impact=computeImpacts([wrong,right],inventory)[0];assert.equal(impact.sample,1);assert.equal(impact.lostMatches,1);assert.equal(impact.misattributed,0);assert.deepEqual(impact.examples[0],{key:'12345',wrong:null,right:'0000012345'});
  const dossier=buildDossier('U2',inventory,{utc:'2026-01-01',relations:[wrong,right]},{fullModel:'synthetic.model',mappings:[{relationId:right.relationId,uslColumn:'id'}]},cfg,thresholds,[],null);
  assert.equal(dossier.foreignKeys.length,1);assert.equal(dossier.forbidden.length,1);assert.equal(dossier.forbidden[0].relationId,wrong.relationId);assert.equal(dossier.forbidden[0].operation,'literal-equality-only');
});
test('dossier preserves FK aliases, cost exclusion and evidence; never includes misleading FK',()=>{
  const rejected=misleading(),accepted={...misleading(),relationId:'synthetic_supported',verdict:'SOSTENIDA'},pending={...misleading(),relationId:'synthetic_pending',verdict:'INDETERMINADA',evidence:{...misleading().evidence,alerts:['quality-review']}};
  const d=buildDossier('U1',inventory,{utc:'2026-01-01',relations:[accepted,rejected,pending]},{fullModel:'synthetic.model',mappings:[{relationId:accepted.relationId,uslColumn:'id__fk_2'}]},cfg,thresholds,['reference'],{status:'NOT_SUPPORTED_TESTED_FORM',compileStatements:1});
  assert.equal(d.foreignKeys[0].uslColumn,'id__fk_2');assert.equal(d.foreignKeys[0].confidence,.85);assert.equal(d.foreignKeys[0].costExcluded,true);assert.equal(d.forbidden[0].evidenceId,rejected.evidenceId);
  for(const key of ['from','to','reason','evidenceId','confidence','evidence','normalization'])assert.ok(key in d.foreignKeys[0]&&key in d.forbidden[0]);
  assert.ok(d.markdown.includes('## Rechazadas (Negative USL)'));assert.ok(d.markdown.includes('## Pendientes'));assert.ok(d.markdown.includes('## Excluidas por coste'));assert.ok(d.markdown.includes('synth-a'));assert.ok(d.pending[0].missing.some((s:string)=>s.includes('alertas')));
  assert.throws(()=>buildDossier('U1',inventory,{utc:'2026-01-01',relations:[rejected]},{mappings:[{relationId:rejected.relationId,uslColumn:'id'}]},cfg,thresholds,[],null),/USL_FK_NO_LONGER_SUPPORTED/);
});
test('HTML highlights actual impact with provenance and escaped labels',()=>{
  const r=misleading(1);r.evidence.queries[1].rows[0][1]='<script>unsafe</script>';
  const html=reportHtml('U1',{sampleMode:true,mode:'offline',runId:'synthetic'},{sourceUtc:'2026-01-01',artifacts:{discovery:inventory,relaciones:{relations:[r]},fichas:{fichas:[]},eval:{},'usl-demo':{}},ledger:[],receipts:[]});
  assert.ok(html.includes('El coste del error'));assert.ok(html.includes('1 de 1'));assert.ok(html.includes('&lt;script&gt;unsafe'));assert.ok(!html.includes('<script>unsafe'));assert.ok(html.includes('CACHED 2026-01-01'));
});

test('a real critic downgrade keeps the deployed FK in review and provisionally excludes new publication',()=>{
  const baseline=misleading(3);
  const counter={strategy:'new fringe; referenced side uniqueness',requestId:'critic-target',utc:'2026-01-02',sql:'SELECT id FROM SYNTH.other WHERE id IN (1) LIMIT 50',metrics:{sourceRequestId:'critic-source',overlap:1,duplicateKeys:[{key:'1',rows:2}]}};
  const relation={...baseline,relationId:'synthetic_critic_downgrade',verdict:'INDETERMINADA',rule:'critic_downgrade',critic:{status:'DEGRADED',reason:'duplicate_referenced_keys_in_bounded_result',counterprobes:[counter]}};
  const d=buildDossier('U1',inventory,{utc:'2026-01-01',critic:{utc:'2026-01-02'},relations:[relation]},
    {fullModel:'synthetic.existing_model',mappings:[{relationId:relation.relationId,uslColumn:'id__fk_2'}]},cfg,thresholds,[],null);
  assert.equal(d.foreignKeys.length,1);assert.equal(d.foreignKeys[0].reviewStatus,'en revisión');
  assert.equal(d.foreignKeys[0].uslColumn,'id__fk_2');assert.equal(d.foreignKeys[0].eligibleForNewUsl,false);
  assert.equal(d.foreignKeys[0].confidence,0);assert.equal(d.foreignKeys[0].evidence.baselineUtc,'2026-01-01');
  assert.equal(d.foreignKeys[0].evidence.utc,'2026-01-02');assert.ok(d.foreignKeys[0].evidenceId.includes('critic-target'));
  assert.deepEqual(d.foreignKeys[0].evidence.requestIds,['synth-a','synth-b','critic-source','critic-target']);
  assert.equal(d.forbidden[0].operation,'excluded-pending-critic-review');assert.equal(d.forbidden[0].verdict,'INDETERMINADA');
  assert.ok(d.pending[0].missing.some((s:string)=>s.includes('duplicate_referenced_keys')));
  assert.ok(d.markdown.includes('en revisión'));assert.ok(d.markdown.includes('critic-target'));assert.ok(d.markdown.includes('exclusión provisional'));
  // Rendering the dossier must not mutate or delete the model mapping.
  assert.equal(relation.verdict,'INDETERMINADA');assert.equal(relation.evidence.utc,'2026-01-01');
});

test('fresh critic overlap is scored independently of the baseline and missing evidence stays missing',()=>{
  const r={...misleading(),verdict:'SOSTENIDA',critic:{status:'CONFIRMED',counterprobes:[{requestId:'synthetic-new',metrics:{overlap:.8}}]}};
  assert.ok(Math.abs(evidenceConfidence(r,cfg)!-.8)<1e-12);
  assert.equal(evidenceConfidence({evidence:{}},cfg),null);
  assert.equal(evidenceConfidence({evidence:{kind:'schema-correspondence',overlap:{ratio:1}}},cfg),null);
  assert.equal(evidenceConfidence({...r,critic:{status:'DEGRADED'}},cfg),0);
});
