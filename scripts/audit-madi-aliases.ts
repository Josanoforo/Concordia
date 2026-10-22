import { auditMadiAliases } from '../src/madi.ts';
const result=auditMadiAliases();
console.log(JSON.stringify({status:result.status,registry:result.registry,summary:result.summary,usesGold:result.usesGold,usesSourceValues:result.usesSourceValues,usesNetwork:result.usesNetwork,output:'out/U3/alias-audit.json'}));
