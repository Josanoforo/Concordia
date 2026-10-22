import { connection } from './connection.ts';
import { failure, loadLocalEnv, SafeError } from './runtime.ts';
import { routePreviews } from './route-preview.ts';
import { discover } from './discovery/index.ts';
import { probe } from './probe/index.ts';
import { verdicts } from './probe/verdicts.ts';
import { evaluate } from './eval.ts';
import { usl } from './usl/index.ts';
import { hmemSmoke } from './hmem-smoke.ts';
import { completeLlm } from './llm-completion.ts';
import { reconcile } from './reconcile/index.ts';
import { review } from './review.ts';
import { demo } from './demo.ts';
import { assertRegistrationContact, register } from './register.ts';
import { discoverUniverse, probeUniverse, evaluateUniverse, universeConfig } from './universe-pipeline.ts';
import { completeUsl } from './usl/complete.ts';
import { registerMadi } from './register-madi.ts';
import { discoverMappings, probeMappings, evaluateMadi } from './madi.ts';
import { uslDossier } from './usl/dossier.ts';
import { criticize } from './critic/adversarial.ts';
import { publishDecisions } from './decisions.ts';
import { evaluateCritic } from './critic/eval.ts';
try {
  const command = process.argv[2];
  const option = (name:string) => { const eq=process.argv.find(x=>x.startsWith('--'+name+'=')); const i=process.argv.indexOf('--'+name); return eq?.slice(name.length+3)??(i>=0?process.argv[i+1]:undefined); };
  const universeId=option('universe')??'U1';
  if (!/^U[123]$/.test(universeId)) throw new SafeError('INVALID_UNIVERSE');
  if(command==='register'&&universeId==='U2')assertRegistrationContact();
  if (['smoke','test-connection','route-preview','discover','probe','critic','usl','demo','complete-llm','register'].includes(command) && !(command==='demo'&&process.env.SAMPLE_MODE==='true') && !(command==='register'&&universeId==='U3')) loadLocalEnv();
  if (command === 'smoke' || command === 'test-connection') await connection(command === 'smoke');
  else if (command === 'route-preview') await routePreviews();
  else if (command === 'register') {if(universeId==='U3')await registerMadi();else await register(universeId);}
  else if (command === 'discover') { if(universeId==='U1')await discover(); else if(universeConfig(universeId).kind==='schema-matching')await discoverMappings(universeId);else await discoverUniverse(universeId); }
  else if (command === 'probe') { if(universeId==='U1'){await probe(); verdicts();}else if(universeConfig(universeId).kind==='schema-matching')await probeMappings(universeId);else await probeUniverse(universeId); }
  else if (command === 'critic') { const rid=option('relationId'); const c=await criticize(universeId,{includeExcluded:process.argv.includes('--include-cost-excluded'),relationIds:rid?[rid]:undefined,force:process.argv.includes('--force')}); console.log('Crítica',universeId,JSON.stringify({confirmed:c.confirmed,degraded:c.degraded,insufficient:c.insufficient,skipped:c.skipped})); }
  else if (command === 'eval-critic') { console.log(JSON.stringify(evaluateCritic(universeId))); }
  else if (command === 'publish-decisions') { const result=await publishDecisions(universeId,process.argv.includes('--dry-run')); console.log('Decisiones',universeId,JSON.stringify(result)); }
  else if (command === 'verdict') verdicts();
  else if (command === 'eval') { if(universeId==='U1')evaluate();else if(universeId==='U3')evaluateMadi();else evaluateUniverse(universeId); }
  else if (command === 'usl') { if(process.argv.includes('--minimal'))await usl();else await completeUsl(universeId); }
  else if (command === 'usl-dossier') {const result=uslDossier(universeId);console.log(result.cacheLabel,'USL dossier',universeId,'FK',result.foreignKeys.length,'negative',result.forbidden.length);}
  else if (command === 'hmem-smoke') hmemSmoke();
  else if (command === 'complete-llm') await completeLlm();
  else if (command === 'reconcile') reconcile(universeId);
  else if (command === 'review') await review(universeId,option('decide'),option('note'),option('actor'),process.argv.includes('--list'));
  else if (command === 'demo') await demo(universeId);
  else throw new SafeError('COMMAND_PENDING_IMPLEMENTATION');
} catch (error) { console.error('FAIL', JSON.stringify(failure(error))); process.exitCode = 1; }
