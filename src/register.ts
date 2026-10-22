import fs from 'node:fs';
import path from 'node:path';
import { Zetaris } from './clients/zetaris.ts';
import { failure, readJson, ROOT, setTraceRun, stamp, writeJson, SafeError } from './runtime.ts';

// Split only catalog statements, never COMPILE USL. Quoted semicolons and
// comments are handled so no commented teardown can become executable.
export function splitCatalogSql(text:string) {
  const statements:string[]=[]; let current='', quote='', lineComment=false, blockComment=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i], next=text[i+1];
    if(lineComment) { if(c==='\n'){lineComment=false;current+='\n';} continue; }
    if(blockComment) {if(c==='*'&&next==='/'){blockComment=false;i++;current+=' ';} continue;}
    if(quote) {current+=c;if(c===quote){if(next===quote){current+=next;i++;}else quote='';}continue;}
    if(c==='-'&&next==='-'){lineComment=true;i++;continue;}
    if(c==='/'&&next==='*'){blockComment=true;i++;continue;}
    if(['\'', '"','`'].includes(c)){quote=c;current+=c;continue;}
    if(c===';'){if(current.trim())statements.push(current.trim());current='';}else current+=c;
  }
  if(quote||blockComment)throw new SafeError('UNTERMINATED_CATALOG_SQL');
  if(current.trim())statements.push(current.trim()); return statements;
}
export function registrationDecision(sql:string) {
  if(!/^(CREATE (?:LIGHTNING (?:DATABASE|REST TABLE)|SCHEMASTORE (?:CONTAINER|VIEW))|CACHE TABLE)\b/i.test(sql)) return 'not-an-authorized-registration-statement';
  if(/\b(?:JOIN|COUNT\s*\(|ORDER\s+BY|GROUP\s+BY)\b/i.test(sql))return 'remote-join-or-aggregate-prohibited';
  if(/SELECT\s+(?:\w+\.)?\*/i.test(sql))return 'wildcard-projection-prohibited';
  return null;
}
export function assertRegistrationContact(cfg:any=readJson('config/onboarding.json')) {
  if(cfg.registrationEnabled!==true||typeof cfg.userAgent!=='string'||/@[^\s@]+\.invalid\b/i.test(cfg.userAgent)||! /^[^\r\n"']+ [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(cfg.userAgent))throw new SafeError('REGISTRATION_CONTACT_NOT_CONFIGURED');
}
export async function register(universeId:string) {
  if(universeId!=='U2')throw new SafeError('REGISTER_ONLY_AUTHORIZED_U2');
  const cfg=readJson('config/onboarding.json');
  assertRegistrationContact(cfg);
  const runId='register-U2-'+stamp(),dir='evidence/runs/'+runId, tracePath=path.join(ROOT,'evidence/trace.jsonl');
  const offset=fs.existsSync(tracePath)?fs.readFileSync(tracePath,'utf8').length:0;
  const result:any={runId,utc:new Date().toISOString(),status:'IN_PROGRESS',sources:[],generations:0,source:'official local catalog; one statement per REST request; no automatic retries'};
  const z=new Zetaris(); setTraceRun(runId);
  try {
    for(const source of cfg.sources) {
      const item:any={id:source.id,file:source.file,status:'IN_PROGRESS',statements:[]}; result.sources.push(item);
      const sqlFile=fs.readFileSync(path.join(ROOT,'../getting-started',source.file),'utf8');
      const statements=splitCatalogSql(sqlFile);
      for(const [index,original] of statements.entries()) {
        const sql=original.replaceAll('YOUR_APP_NAME YOUR_CONTACT_EMAIL',cfg.userAgent);
        const skipReason=registrationDecision(sql);
        if(skipReason){item.statements.push({index,status:'SKIPPED_POLICY',reason:skipReason,sql});continue;}
        try {
          const response=await z.runSql(sql,1);
          item.statements.push({index,status:'PASS',...response}); console.log('PASS register',source.id,index,sql.split('\n')[0]);
        } catch(error) {
          const detail=failure(error);
          const exists=/already exists|already registered|is existing/i.test(detail.detail??'');
          item.statements.push({index,status:exists?'EXISTS':'FAIL',sql,error:detail});
          if(exists){console.log('EXISTS register',source.id,index);continue;}
          item.status=source.optionalCanary?'CANARY_FAIL':'BLOCKED';
          item.error=detail; console.log(item.status,'register',source.id,JSON.stringify(detail)); break;
        }
        writeJson(dir+'/registration.json',result);
      }
      if(item.status==='IN_PROGRESS')item.status='PASS';
      writeJson(dir+'/registration.json',result);
      if(item.status==='BLOCKED'){result.status='BLOCKED';break;}
    }
    if(result.status==='IN_PROGRESS')result.status='PASS';
  } catch(error) {result.status='BLOCKED';result.error=failure(error);}
  finally {
    writeJson(dir+'/registration.json',result); writeJson('out/U2/registration.json',result); writeJson(dir+'/receipts.json',[]);
    if(fs.existsSync(tracePath))fs.writeFileSync(path.join(ROOT,dir,'trace.jsonl'),fs.readFileSync(tracePath,'utf8').slice(offset));
    setTraceRun();
    if(result.status!=='PASS') {
      fs.appendFileSync(path.join(ROOT,'docs/reportes/REPORTE_D2.md'),'\n## Bloqueo de registro U2\n\n'+JSON.stringify(result.sources.find((s:any)=>s.status==='BLOCKED')?.error??result.error)+'\n\nEvidencia: out/U2/registration.json y '+dir+'/registration.json. Ejecución detenida según sección 0; no se declara registro U2 ni cierre D2. No se cambió red, Docker, configuración, ni se reintentó.\n');
      process.exitCode=1;
    }
  }
  return result;
}
