import fs from 'node:fs';
const selected=[['checkout','v7.0.1'],['setup-node','v7.1.0'],['upload-artifact','v7.0.2']];
const actions=await Promise.all(selected.map(async([name,tag])=>{
  const response=await fetch(`https://api.github.com/repos/actions/${name}/git/ref/tags/${tag}`);
  if(!response.ok)throw new Error('Official action lookup failed: '+response.status);
  let object=(await response.json()).object;
  if(object.type==='tag')object=(await(await fetch(object.url)).json()).object;
  if(object.type!=='commit')throw new Error('Official tag did not resolve to commit');
  const yaml=await(await fetch(`https://raw.githubusercontent.com/actions/${name}/${object.sha}/action.yml`)).text();
  return {name,tag,sha:object.sha,runtime:yaml.match(/using:\s*['"]?([a-z0-9]+)/)?.[1],inputs:yaml.split('\n').filter(l=>/^  [a-z][-a-z_]*:$/.test(l)).map(l=>l.trim().slice(0,-1)),url:`https://github.com/actions/${name}/releases/tag/${tag}`};
}));
fs.mkdirSync('.github',{recursive:true});
fs.writeFileSync('.github/actions-versions.json',JSON.stringify({checkedUtc:new Date().toISOString(),source:'Official actions repositories; pinned tags resolved to commit SHA',actions},null,2)+'\n');
console.log(JSON.stringify(actions,null,2));
