import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataRoot=path.join(root,'.concordia/data/madi');
const revision='062058d09c8abd97026e6d4e9908b433753f58d3';
const raw=`https://raw.githubusercontent.com/wbsg-uni-mannheim/MaDI-Bench/${revision}/`;
const domains=['games','companies','music','products','papers'];
const words=s=>String(s??'').toLowerCase().replace(/([a-z])([A-Z])/g,'$1 $2').split(/[^a-z0-9]+/).filter(x=>x.length>1);
const csvRows=text=>{const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}return rows;};
const key=m=>JSON.stringify([m.source_dataset,m.source_column,m.target_dataset,m.target_column]);
function metrics(pred,gold){const p=new Set(pred.map(key)),g=new Set(gold.map(key)),tp=[...p].filter(k=>g.has(k)).length;return {predicted:p.size,gold:g.size,tp,fp:p.size-tp,fn:g.size-tp,precision:p.size?tp/p.size:null,recall:g.size?tp/g.size:null};}
function similarity(a,b){const A=new Set(words(a)),B=new Set(words(b));if(!A.size||!B.size)return 0;const j=[...A].filter(x=>B.has(x)).length/(new Set([...A,...B]).size);const shared=[...A].filter(x=>B.has(x)).length;return j+(shared?0.1:0);}
function localPath(domain,relative){const base=path.join(dataRoot,domain==='companies'?'':domain);return path.join(base,relative);}
function schema(domain){return JSON.parse(fs.readFileSync(localPath(domain,'schemamatching/target_schema.json'),'utf8'));}
function predict(domain){const base=domain==='companies'?'':domain,dataDir=localPath(domain,'data'),target=schema(domain),files=fs.readdirSync(dataDir).filter(x=>x.endsWith('_metadata.json')).sort(),out=[];
  for(const file of files){let source=file.replace('_metadata.json','');if(domain==='products')source=source.replace('dataset_','products_');const meta=JSON.parse(fs.readFileSync(path.join(dataDir,file),'utf8'));
    for(const v of meta.variableMeasured??[]){const ranked=Object.entries(target.properties??{}).map(([name,t])=>({name,score:similarity(v.name+' '+v.description,name+' '+(t.description??''))})).sort((a,b)=>b.score-a.score);if(ranked[0]?.score>=0.18&&ranked[0].score>(ranked[1]?.score??0)+0.04)out.push({source_dataset:source,source_column:v.name,target_dataset:'target_schema',target_column:ranked[0].name});}
  }return out;
}
async function authorPredictions(domain,tree){const prefix=`results/llm pipeline/${domain}/baseline/schema_matching/mappings/`,files=tree.filter(x=>x.type==='blob'&&x.path.startsWith(prefix)&&x.path.endsWith('_mapping.csv'));const all=[];
  for(const f of files){const response=await fetch(raw+encodeURI(f.path),{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Author mapping fetch failed');const rows=csvRows(await response.text()),headers=rows.shift()??[];for(const row of rows){const o=Object.fromEntries(headers.map((h,i)=>[h,row[i]??'']));if(o.source_dataset&&o.source_column&&o.target_dataset&&o.target_column)all.push(o);}}
  return all;
}
async function main(){const treeResponse=await fetch(`https://api.github.com/repos/wbsg-uni-mannheim/MaDI-Bench/git/trees/${revision}?recursive=1`,{headers:{'User-Agent':'Concordia-local-evaluation'},signal:AbortSignal.timeout(30000)});if(!treeResponse.ok)throw new Error('Pinned MaDI inventory unavailable');const tree=(await treeResponse.json()).tree;if(!Array.isArray(tree))throw new Error('Incomplete pinned MaDI inventory');const result=[];
  for(const domain of domains){const goldPath=localPath(domain,'schemamatching/sm_mapping_gold.json'),rawGold=JSON.parse(fs.readFileSync(goldPath,'utf8')),gold=Array.isArray(rawGold)?rawGold:rawGold.mappings;if(!Array.isArray(gold))throw new Error('Gold contract unsupported');const heuristic=predict(domain),author=(await authorPredictions(domain,tree)).map(x=>({...x,target_dataset:'target_schema'}));const normalizedGold=gold.map(x=>({...x,target_dataset:x.target_dataset??'target_schema'}));
    // Source and target dataset labels are preserved from the benchmark; no gold rows are emitted.
    const row={domain,heuristic:metrics(heuristic,normalizedGold),authorLlmBaseline:metrics(author,normalizedGold),sources:fs.readdirSync(path.join(dataRoot,...(domain==='companies'?[]:[domain]),'data')).filter(x=>x.endsWith('_metadata.json')).length};result.push(row);
    const outputDir=path.join(root,'out/madi',domain);fs.mkdirSync(outputDir,{recursive:true});const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const html=`<!doctype html><meta charset="utf-8"><title>MaDI ${esc(domain)} schema mapping</title><h1>MaDI ${esc(domain)} schema mapping</h1><p>Metadata-only deterministic predictions evaluated against the pinned schema-matching gold. No source values or gold mappings are shown. Revision ${revision}.</p><table><thead><tr><th>Method</th><th>Precision</th><th>Recall</th><th>Predicted</th><th>Gold</th></tr></thead><tbody>${[['Metadata heuristic',row.heuristic],['Author LLM baseline',row.authorLlmBaseline]].map(([name,m])=>`<tr><th>${name}</th><td>${m.precision==null?'n/a':m.precision.toFixed(3)}</td><td>${m.recall==null?'n/a':m.recall.toFixed(3)}</td><td>${m.predicted}</td><td>${m.gold}</td></tr>`).join('')}</tbody></table>`;fs.writeFileSync(path.join(outputDir,'report.html'),html);
  }
  const evidence={utc:new Date().toISOString(),revision,scope:'column correspondence only; no entity resolution/fusion; aggregates only',domains:result};fs.writeFileSync(path.join(root,'.concordia/madi-domain-metrics.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}
main().catch(error=>{console.error('FAIL',error.message);process.exitCode=1;});
