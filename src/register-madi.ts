import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { ROOT, failure, loadLocalEnv, readJson, SafeError, setTraceRun, stamp, writeJson } from './runtime.ts';
import { universeConfig } from './universe-pipeline.ts';
export async function registerMadi(){
  const cfg=universeConfig('U3'),runId='d3-register-U3-'+stamp();
  const result:any={utc:new Date().toISOString(),runId,status:'IN_PROGRESS',database:cfg.database,files:[],steps:[],excluded:[],localEvaluationOnly:true};
  const subprocessEnv={...process.env};
  for(const key of ['ZETARIS_API_KEY','METERLESS_RUNTIME_TOKEN'])delete subprocessEnv[key];
  const docker=(args:string[])=>execFileSync('wsl.exe',['--exec','docker',...args],{cwd:ROOT,env:subprocessEnv,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']}).replaceAll('\u0000','').trim();
  try{
    const inventory=docker(['ps','--filter','label=com.docker.compose.project=zetaris','--filter','label=com.docker.compose.service=driver','--format','{{.ID}}']);
    if(!/^[a-f0-9]{12,64}$/.test(inventory))throw new SafeError('UNAMBIGUOUS_DRIVER_REQUIRED');
    const mounts=JSON.parse(docker(['inspect','--format','{{json .Mounts}}',inventory]));
    const mount=mounts.find((m:any)=>m.Type==='volume'&&m.Destination==='/home/zetaris/customer-data');
    if(!mount)throw new SafeError('EXPECTED_CUSTOMER_DATA_VOLUME_REQUIRED');
    const manifest=readJson(cfg.localInput+'/manifest.json');
    const targetDir='/home/zetaris/customer-data/shared/concordia-madi-'+manifest.revision.slice(0,12);
    for(const [name,spec] of Object.entries<any>(cfg.tables)){
      identifier(name);
      const file=path.resolve(ROOT,cfg.localInput,spec.file),allowed=path.resolve(ROOT,'.concordia/data/madi/data')+path.sep;
      if(!file.startsWith(allowed)||!file.endsWith('.csv'))throw new SafeError('COPY_PATH_OUTSIDE_MADI_INPUT');
      const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if(manifest.files.find((f:any)=>f.path===spec.file)?.sha256!==hash)throw new SafeError('MADI_INPUT_HASH_CHANGED');
      const target=path.posix.resolve(targetDir,name+'.csv');
      if(!target.startsWith(mount.Destination+'/shared/concordia-madi-'))throw new SafeError('COPY_OUTSIDE_AUTHORIZED_VOLUME');
      docker(['exec',inventory,'mkdir','-p',targetDir]);
      let copiedHash:string|null=null;
      try{copiedHash=docker(['exec',inventory,'sha256sum',target]).split(/\s+/)[0];}
      catch(error){const detail=String((error as any).stderr??'');if(!/No such file or directory/.test(detail))throw new SafeError('MADI_DESTINATION_INSPECTION_FAILED');}
      if(copiedHash&&copiedHash!==hash)throw new SafeError('EXISTING_MADI_FILE_DIFFERS_NO_OVERWRITE');
      if(!copiedHash)docker(['cp','/mnt/'+file[0].toLowerCase()+file.slice(2).replaceAll('\\','/'),inventory+':'+target]);
      if(docker(['exec',inventory,'sha256sum',target]).split(/\s+/)[0]!==hash)throw new SafeError('MADI_COPY_HASH_MISMATCH');
      result.files.push({table:name,path:target,sha256:hash,copied:!copiedHash});
    }
    // Only now load credentials; Docker subprocesses never inherit them.
    loadLocalEnv();setTraceRun(runId);const z=new Zetaris();
    const databases=await z.listDatabases();result.steps.push(databases);
    if(!databases.rows.some(r=>r[0]===cfg.database))result.steps.push(await z.runSql(`CREATE LIGHTNING DATABASE ${identifier(cfg.database)} DESCRIBE BY "MaDI Companies local evaluation only"`,1));
    const tables=await z.listTables(cfg.database);result.steps.push(tables);
    for(const file of result.files){
      if(!tables.rows.some(r=>r[0]===file.table))result.steps.push(await z.runSql(`CREATE LIGHTNING FILESTORE TABLE ${identifier(file.table)} FROM ${identifier(cfg.database)} FORMAT CSV OPTIONS (PATH "${file.path}", header "true", inferSchema "false")`,1));
      const columns=cfg.tables[file.table].columns.map((c:any)=>identifier(c.name));
      try{
        const response=await z.runSql(`SELECT ${columns.length?columns.join(', '):'1 AS row_present'} FROM ${identifier(cfg.database)}.${identifier(file.table)} LIMIT 3`,3,{timeoutMs:60000});
        if(!response.rows.length)throw new SafeError('MADI_EMPTY_TABLE');
        result.steps.push({...response,stage:'verify_'+file.table});
      }catch(error){if(failure(error).code!=='TIMEOUT')throw error;result.excluded.push(file.table);result.steps.push({stage:'cost_excluded_'+file.table,error:failure(error),timeoutMs:60000});}
      writeJson('.concordia/U3/registration.json',result);
    }
    result.status='PASS';
  }catch(error){result.status='BLOCKED';result.error=error instanceof SafeError?failure(error):{code:'WSL_COPY_FAILED',exitCode:(error as any).status??null};
    fs.appendFileSync(path.join(ROOT,'docs/reportes/REPORTE_D3.md'),`\n## Bloqueo registro MaDI\n\n${JSON.stringify(result.error)}. Se detiene; no se modifica configuración Docker.\n`);throw new SafeError(result.error.code);
  }finally{writeJson('.concordia/U3/registration.json',result);writeJson('out/U3/registration.json',result);setTraceRun();}
  console.log('PASS register MADI_COMPANIES',result.files.length,'sources; excluded',result.excluded.length);return result;
}
