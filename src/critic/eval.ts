import { readJson, writeJson, SafeError } from '../runtime.ts';

export function evaluateCritic(id='U1'){
  const fixture=readJson<any>(`eval/cases/critic-${id}.json`),relations=readJson<any>(`out/${id}/relaciones.json`).relations,results:any[]=[];
  const critic=readJson<any>(`out/${id}/critic.json`),byId=new Map<string,any>(critic.results.map((x:any)=>[x.relationId,x]));
  for(const c of fixture.cases){
    const r=c.relationId?relations.find((x:any)=>x.relationId===c.relationId):relations.find((x:any)=>(`${x.from.table}.${x.from.column}`===c.from&&`${x.to.table}.${x.to.column}`===c.to)||Boolean(c.symmetric&&`${x.from.table}.${x.from.column}`===c.to&&`${x.to.table}.${x.to.column}`===c.from));
    let actual='MISSING_RELATION',pass=false;
    if(r){
      const outcome=byId.get(r.relationId);
      if(r.verdict==='SOSTENIDA'||r.originalCriticVerdict==='SOSTENIDA'||r.critic?.status){actual=outcome?.status??'MISSING_COUNTERPROBE';pass=Boolean(outcome&&['CONFIRMED','DEGRADED','INSUFFICIENT','ERROR'].includes(outcome.status));}
      else{actual=outcome?.status??'NOT_COUNTERPROBED';pass=!outcome||outcome.status==='SKIPPED';}
    }
    results.push({id:c.id,relationId:r?.relationId,expected:c.expected,actual,pass});
  }
  const result={utc:new Date().toISOString(),universe:id,total:results.length,correct:results.filter((r:any)=>r.pass).length,status:results.every((r:any)=>r.pass)?'PASS':'FAIL',results};
  writeJson(`out/${id}/critic-eval.json`,result);if(result.status!=='PASS')throw new SafeError('CRITIC_EVAL_FAILED');return result;
}
