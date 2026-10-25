import fs from 'node:fs';
import path from 'node:path';
import { Reconciler } from '../src/reconcile/index.ts';

const [dir,action,argument,gate1,result1,gate2,result2,actor='process-worker']=process.argv.slice(2);
const waitFor=(file:string)=>new Promise<void>((resolve,reject)=>{
  const started=Date.now();
  const poll=()=>{if(fs.existsSync(file))return resolve();if(Date.now()-started>15000)return reject(new Error('BARRIER_TIMEOUT'));setTimeout(poll,10);};poll();
});
const writeResult=(file:string,value:unknown)=>fs.writeFileSync(file,JSON.stringify(value));
async function main(){
  const reconciler=new Reconciler('U1',dir,actor),conflict=reconciler.conflicts.find(item=>item.status==='queued');
  if(!conflict)throw new Error('FIXTURE_CONFLICT_MISSING');
  writeResult(result1+'.ready',{pid:process.pid,conflictId:conflict.id,version:conflict.version,claimIds:[...conflict.claimIds]});
  await waitFor(gate1);
  try{
    if(action==='resolve')reconciler.resolve(conflict,argument,true,actor+' review reason',conflict.version);
    else if(action==='alternative'){
      const claim=JSON.parse(argument);reconciler.addClaim(claim);reconciler.detect();
    }else throw new Error('UNKNOWN_WORKER_ACTION');
    writeResult(result1,{status:'PASS',pid:process.pid,version:conflict.version,claimIds:[...conflict.claimIds]});
  }catch(error:any){writeResult(result1,{status:error?.code??error?.message??'ERROR',pid:process.pid});}
  if(gate2&&result2){
    await waitFor(gate2);
    try{reconciler.resolve(conflict,argument,true,actor+' retry reason',conflict.version);writeResult(result2,{status:'PASS',pid:process.pid});}
    catch(error:any){writeResult(result2,{status:error?.code??error?.message??'ERROR',pid:process.pid});}
  }
}
main().catch(error=>{writeResult(result1+'.fatal',{message:error?.message??'worker failed'});process.exitCode=2;});