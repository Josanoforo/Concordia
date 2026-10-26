import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { ROOT, failure, loadLocalEnv, SafeError, writeJson } from './runtime.ts';

const revision='062058d09c8abd97026e6d4e9908b433753f58d3';
const domains=['games','companies','music','products','papers'];
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const csvCell=(value:unknown)=>{let text=value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;};
function sourceBase(domain:string){return path.join(ROOT,'.concordia','data','madi',...(domain==='companies'?[]:[domain]));}
function materialize(domain:string,source:string,metadata:any){
  const base=sourceBase(domain),relative=path.join('data',source+'.'+(domain==='companies'||domain==='games'||domain==='music'?'csv':domain==='products'?'json':'jsonl'));
  const original=path.join(base,relative),bytes=fs.readFileSync(original),manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
  const expected=manifest.files.find((f:any)=>f.path===relative.replaceAll('\\','/'));
  if(!expected||expected.sha256!==digest(bytes))throw new SafeError('MADI_INPUT_HASH_MISMATCH');
  let csv=bytes;
  if(relative.endsWith('.json')||relative.endsWith('.jsonl')){
    const fields=(metadata.variableMeasured??[]).map((x:any)=>x.name);
    if(!fields.length||fields.some((x:string)=>!/^[_A-Za-z][_A-Za-z0-9-]*$/.test(x)))throw new SafeError('MADI_METADATA_COLUMNS_INVALID');
    const lines=[fields.map(csvCell).join(',')];
    const push=(row:any)=>lines.push(fields.map((field:string)=>csvCell(row?.[field])).join(','));
    if(relative.endsWith('.json')){const parsed=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(parsed))throw new SafeError('MADI_JSON_ARRAY_REQUIRED');for(const row of parsed)push(row);}
    else for(const line of bytes.toString('utf8').split(/\r?\n/)){if(line.trim())push(JSON.parse(line));}
    csv=Buffer.from(lines.join('\n')+'\n');
  }
  const target=path.join(ROOT,'.concordia','data','madi-registered',domain,source+'.csv');fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target+'.tmp',csv);fs.renameSync(target+'.tmp',target);
  return {source,sourceRelative:relative,localPath:target,sha256:digest(csv),bytes:csv.length,columns:(metadata.variableMeasured??[]).map((x:any)=>x.name)};
}
export async function registerMadiDomains(){
  const output:any={utc:new Date().toISOString(),revision,status:'IN_PROGRESS',domains:{},localOnly:true,rowsNotSelected:true};
  let stage='locate_driver';
  const env={...process.env};for(const key of ['ZETARIS_API_KEY','METERLESS_RUNTIME_TOKEN'])delete env[key];
  const docker=(args:string[])=>execFileSync('wsl.exe',['--exec','docker',...args],{cwd:ROOT,env,encoding:'utf8',windowsHide:true,timeout:120000,stdio:['ignore','pipe','pipe']}).replaceAll('\u0000','').trim();
  try{
    const matches=docker(['ps','--filter','label=com.docker.compose.project=zetaris','--filter','label=com.docker.compose.service=driver','--format','{{.ID}}']);
    if(!/^[a-f0-9]{12,64}$/.test(matches))throw new SafeError('UNAMBIGUOUS_DRIVER_REQUIRED');
    const mounts=JSON.parse(docker(['inspect','--format','{{json .Mounts}}',matches])),mount=mounts.find((m:any)=>m.Type==='volume'&&m.Destination==='/home/zetaris/customer-data');
    if(!mount)throw new SafeError('EXPECTED_CUSTOMER_DATA_VOLUME_REQUIRED');
    for(const domain of domains){stage='prepare_'+domain;const base=sourceBase(domain),manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8')),mdDir=path.join(base,'data');const sources=fs.readdirSync(mdDir).filter(x=>x.endsWith('_metadata.json')).map(x=>x.replace('_metadata.json','')).sort();const files=[];
      for(const source of sources){const metadata=JSON.parse(fs.readFileSync(path.join(mdDir,source+'_metadata.json'),'utf8'));const file=materialize(domain,source,metadata),db='MADI08_'+domain.toUpperCase(),table=identifier(source),targetDir=`/home/zetaris/customer-data/shared/concordia-madi-${revision.slice(0,12)}-${domain}`,target=path.posix.resolve(targetDir,source+'.csv');
        stage='copy_'+domain+'_'+source;if(!target.startsWith(mount.Destination+'/shared/concordia-madi-'))throw new SafeError('COPY_OUTSIDE_AUTHORIZED_VOLUME');
        docker(['exec',matches,'mkdir','-p',targetDir]);let existing:string|null=null;try{existing=docker(['exec',matches,'sha256sum',target]).split(/\s+/)[0];}catch(error){if(!/No such file or directory/.test(String((error as any).stderr??'')))throw new SafeError('MADI_DESTINATION_INSPECTION_FAILED');}
        if(existing&&existing!==file.sha256)throw new SafeError('EXISTING_MADI_FILE_DIFFERS_NO_OVERWRITE');
        if(!existing)docker(['cp','/mnt/'+file.localPath[0].toLowerCase()+file.localPath.slice(2).replaceAll('\\','/'),matches+':'+target]);
        if(docker(['exec',matches,'sha256sum',target]).split(/\s+/)[0]!==file.sha256)throw new SafeError('MADI_COPY_HASH_MISMATCH');
        files.push({table,database:db,path:target,sha256:file.sha256,columns:file.columns});
      }
      output.domains[domain]={database:'MADI08_'+domain.toUpperCase(),files,attemptedTables:[]};
    }
    stage='connect_zetaris';loadLocalEnv();const z=new Zetaris(),databases=await z.listDatabases();
    for(const domain of domains){stage='register_'+domain;const entry=output.domains[domain],db=entry.database;
      if(!databases.rows.some(r=>r[0]===db))await z.runLegacyMutationSql(`CREATE LIGHTNING DATABASE ${identifier(db)} DESCRIBE BY "MaDI ${domain} local schema mapping evaluation"`,1,{caller:'register-madi-domains'});
      const listed=await z.listTables(db),names=new Set(listed.rows.flat().map(String));
      for(const f of entry.files){stage='verify_'+domain+'_'+f.table;if(!names.has(f.table))await z.runLegacyMutationSql(`CREATE LIGHTNING FILESTORE TABLE ${identifier(f.table)} FROM ${identifier(db)} FORMAT CSV OPTIONS (PATH "${f.path}", header "true", inferSchema "false")`,1,{caller:'register-madi-domains'});
        const record:any={table:f.table,status:'REGISTERED',fileSha256:f.sha256,sourceColumns:f.columns.length};
        try{const verification=await z.runSql(`SELECT 1 AS row_present FROM ${identifier(db)}.${identifier(f.table)} LIMIT 1`,1,{timeoutMs:120000});record.probe='PASS';record.sampleRows=verification.rows.length;record.requestId=verification.requestId;record.durationMs=verification.durationMs;}
        catch(error){const detail=failure(error);if(detail.code==='TIMEOUT'){record.probe='EXCLUDED_TECHNICAL_TIMEOUT';record.timeoutMs=120000;record.error=detail;}else throw error;}
        entry.attemptedTables.push(record);writeJson('.concordia/madi-register-p5.json',output);
      }
      entry.status='PASS';
    }
    output.status='PASS';
  }catch(error){output.status='BLOCKED';output.stage=stage;output.error=failure(error);throw new SafeError('MADI_P5_REGISTRATION_BLOCKED');}
  finally{writeJson('.concordia/madi-register-p5.json',output);}
  return output;
}
