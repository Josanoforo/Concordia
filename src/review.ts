import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Reconciler, reconcile } from './reconcile/index.ts';
import { ROOT, SafeError, writeJson } from './runtime.ts';
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
  const before = fs.readFileSync(path.join(ROOT,'.concordia',universeId,'ledger.jsonl'),'utf8');
  r.resolve(c,match[2],true,note);
  const after = fs.readFileSync(path.join(ROOT,'.concordia',universeId,'ledger.jsonl'),'utf8');
  if (!after.startsWith(before)) throw new SafeError('LEDGER_APPEND_ONLY_VIOLATION');
  writeJson(`evidence/review-${universeId}-${Date.now()}.json`,{utc:new Date().toISOString(),actor,decision:selected,note,conflict:c,appendOnly:true,correction:r.hmem.store.get(c.correction!)});
  reconcile(universeId); console.log('PASS review',c.id,c.status,c.correction);
}
