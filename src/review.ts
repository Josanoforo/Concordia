import readline from 'node:readline/promises';
import { Reconciler, reconcile } from './reconcile/index.ts';
import { ROOT, SafeError, writeJson } from './runtime.ts';
export function resolveReviewDecision(reconciler:Reconciler, conflict:Reconciler['conflicts'][number], claimId:string, note:string) {
  const before=[...reconciler.hmem.ledger.all()].map(entry=>JSON.stringify(entry));
  reconciler.resolve(conflict,claimId,true,note,conflict.version);
  const after=[...reconciler.hmem.ledger.all()].map(entry=>JSON.stringify(entry));
  if(after.length<before.length||before.some((entry,index)=>after[index]!==entry))throw new SafeError('LEDGER_APPEND_ONLY_VIOLATION');
  return {conflict,correction:reconciler.hmem.store.get(conflict.correction!)};
}
export async function review(universeId: string, decision?: string, note='', actor='interactive-user', listOnly=false) {
  const r = new Reconciler(universeId,undefined,actor);
  const queued = r.conflicts.filter(c=>c.status==='queued');
  for (const c of queued.filter(c=>!decision||decision.startsWith(c.id+'='))) console.log(JSON.stringify({conflictId:c.id,entity:c.entity,attribute:c.attribute,alternatives:c.claimIds.map(id=>r.claims.find(x=>x.id===id))},null,2));
  if (!queued.length) { console.log('No queued conflicts'); return; }
  if (listOnly) return;
  let selected = decision;
  if (!selected) {
    if (!process.stdin.isTTY) throw new SafeError('REVIEW_REQUIRES_DECIDE_OR_INTERACTIVE_TERMINAL');
    const prompt = readline.createInterface({input:process.stdin,output:process.stdout});
    try { selected = await prompt.question('Decisión conflictId=claimId (vacío cancela): '); if (selected) note = await prompt.question('Nota opcional: '); }
    finally { prompt.close(); }
  }
  if (!selected) return;
  const match = /^([^=]+)=([^=]+)$/.exec(selected);
  if (!match) throw new SafeError('INVALID_REVIEW_DECISION');
  const c = queued.find(c=>c.id===match[1]); if (!c) throw new SafeError('CONFLICT_NOT_QUEUED');
  const resolved=resolveReviewDecision(r,c,match[2],note);
  writeJson(`evidence/review-${universeId}-${Date.now()}.json`,{utc:new Date().toISOString(),actor,decision:selected,note,conflict:resolved.conflict,appendOnly:true,correction:resolved.correction});
  reconcile(universeId); console.log('PASS review',c.id,c.status,c.correction);
}
