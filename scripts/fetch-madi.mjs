// Only the pinned base/input allowlist; never entitymatching, fusion or results.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const revision='062058d09c8abd97026e6d4e9908b433753f58d3';
const repository='https://api.github.com/repos/wbsg-uni-mannheim/MaDI-Bench';
const base='https://raw.githubusercontent.com/wbsg-uni-mannheim/MaDI-Bench/'+revision+'/';
// Names checked against the pinned Git tree. Only metadata inventory, no
// datasets, was fetched during D4a; --dry-run itself has no network or writes.
const domains={
  companies:{sources:['dbpedia','forbes','fullcontact'],extension:'csv'},
  games:{sources:['dbpedia','metacritic','sales'],extension:'csv'},
  music:{sources:['discogs','lastfm','musicbrainz'],extension:'csv'},
  products:{sources:['dataset_1','dataset_2','dataset_3','dataset_4'],extension:'json'},
  papers:{sources:['crossref','dblp','open_alex'],extension:'jsonl'}
};
export function planMadi(domain='companies'){
  if(!Object.hasOwn(domains,domain))throw new Error('Unsupported MaDI domain');
  const spec=domains[domain],prefix='use cases/'+domain+'/base/input/';
  const files=[...spec.sources.flatMap(source=>['data/'+source+'.'+spec.extension,'data/'+source+'_metadata.json']),
    'schemamatching/target_schema.json','schemamatching/sm_mapping_gold.json'];
  return {revision,domain,scope:prefix,localEvaluationOnly:true,redistributionAuthorized:false,
    destination:path.join(root,'.concordia/data/madi',domain==='companies'?'':domain),
    files:files.map(relative=>({path:relative,source:prefix+relative})),
    licensePolicy:'Audit repository and source metadata before data; absent licenses remain unresolved. Article license does not license datasets or gold. All inputs and gold stay ignored locally.',
    excludes:['entitymatching/','fusion/','normalization/','results/']};
}
export function parseArgs(args){
  let domain='companies',dryRun=false,domainSeen=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--dry-run'){if(dryRun)throw new Error('Duplicate --dry-run');dryRun=true;}
    else if(arg==='--domain'||arg.startsWith('--domain=')){
      if(domainSeen)throw new Error('Duplicate --domain');domainSeen=true;
      domain=arg==='--domain'?args[++i]:arg.slice('--domain='.length);
      if(!domain||domain.startsWith('--'))throw new Error('Missing MaDI domain');
    }else throw new Error('Unsupported argument');
  }
  return {plan:planMadi(domain),dryRun};
}
export async function fetchMadi(plan,request=globalThis.fetch){
  const get=async(url)=>{
    const response=await request(url,{redirect:'error',signal:AbortSignal.timeout(60000),headers:{'User-Agent':'Concordia-MaDI-license-audit'}});
    if(!response.ok)throw new Error('MaDI HTTP '+response.status);
    return response;
  };
  // Repository and per-source metadata are audited before any source data/gold.
  const tree=await (await get(repository+'/git/trees/'+revision+'?recursive=1')).json();
  if(tree.truncated||!Array.isArray(tree.tree))throw new Error('Incomplete MaDI file inventory');
  for(const file of plan.files){
    const entry=tree.tree.find(entry=>entry.path===file.source&&entry.type==='blob');
    if(!entry||!Number.isInteger(entry.size)||entry.size<0||entry.size>64*1024*1024)throw new Error('Missing or oversized allowlisted MaDI input: '+file.path);
    file.expectedBytes=entry.size;
  }
  const citation=await (await get(base+'CITATION.cff')).text();
  const readme=await (await get(base+'README.md')).text();
  const audit={utc:new Date().toISOString(),revision,domain:plan.domain,
    rootLicensePaths:tree.tree.filter(file=>!file.path.includes('/')&&/licen[sc]e/i.test(file.path)).map(file=>file.path),
    citationPresent:true,citationLicenseField:citation.split('\n').filter(line=>/^license:/i.test(line)),
    readmeLicenseLines:readme.split('\n').filter(line=>/licen[sc]e|copyright/i.test(line)),
    paper:{url:'https://arxiv.org/abs/2606.30371v2',licenseLinkObserved:'https://creativecommons.org/licenses/by-nc-nd/4.0/',scope:'article only; checked 2026-10-22'},
    sourceMetadataLicenses:{},localEvaluationOnly:true,redistributionAuthorized:false};
  const cachedMetadata=new Map();
  for(const file of plan.files.filter(file=>file.path.endsWith('_metadata.json'))){
    const bytes=Buffer.from(await (await get(base+encodeURI(file.source))).arrayBuffer());
    if(bytes.length!==file.expectedBytes)throw new Error('MaDI metadata size mismatch');
    audit.sourceMetadataLicenses[path.basename(file.path)]=JSON.parse(bytes.toString('utf8')).license??null;
    cachedMetadata.set(file.path,bytes);
  }
  fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
  fs.writeFileSync(path.join(root,'evidence',plan.domain==='companies'?'madi-license.json':'madi-license-'+plan.domain+'.json'),JSON.stringify(audit,null,2)+'\n');
  const manifest={utc:new Date().toISOString(),revision,domain:plan.domain,scope:plan.scope,localEvaluationOnly:true,redistributionAuthorized:false,files:[]};
  for(const file of plan.files){
    const bytes=cachedMetadata.get(file.path)??Buffer.from(await (await get(base+encodeURI(file.source))).arrayBuffer());
    if(bytes.length!==file.expectedBytes)throw new Error('MaDI input size mismatch: '+file.path);
    const target=path.resolve(plan.destination,file.path);
    if(!target.startsWith(path.resolve(plan.destination)+path.sep))throw new Error('MaDI output outside local input directory');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target+'.tmp',bytes);fs.renameSync(target+'.tmp',target);
    manifest.files.push({path:file.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  fs.writeFileSync(path.join(plan.destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
export async function main(args=process.argv.slice(2)){
  const {plan,dryRun}=parseArgs(args);
  if(dryRun){console.log(JSON.stringify({...plan,dryRun:true,networkRequests:0,downloadedFiles:0,writtenFiles:0},null,2));return;}
  const manifest=await fetchMadi(plan);
  console.log('MaDI: '+manifest.files.length+' archivos, solo '+plan.scope+', evaluación local. '+plan.destination);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error('FAIL '+error.message);process.exitCode=1;});
}
