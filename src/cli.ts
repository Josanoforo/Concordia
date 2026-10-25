import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { connection } from './connection.ts';
import { failure, loadLocalEnv, SafeError, readJson, writeJson, ROOT } from './runtime.ts';
import { Zetaris } from './clients/zetaris.ts';
import { routePreviews } from './route-preview.ts';
import { verdicts } from './probe/verdicts.ts';
import { usl } from './usl/index.ts';
import { hmemSmoke } from './hmem-smoke.ts';
import { completeLlm } from './llm-completion.ts';
import { reconcile } from './reconcile/index.ts';
import { review } from './review.ts';
import { demo } from './demo.ts';
import { assertRegistrationContact, register } from './register.ts';
import { evaluateLocalFixtureUniverse } from './universe-pipeline.ts';
import { completeUsl } from './usl/complete.ts';
import { registerMadi } from './register-madi.ts';
import { registerMadiDomains } from './register-madi-domains.ts';
import { uslDossier } from './usl/dossier.ts';
import { criticize } from './critic/adversarial.ts';
import { publishDecisions } from './decisions.ts';
import { evaluateCritic } from './critic/eval.ts';
import { assessPublicationApplyPreconditions, checkPublicationPlanPreconditions, compilePublicationPlan, type PublicationManifest, type PublicationPlanInput } from './usl/publication-plan.ts';
import { assessUslLifecycleApplyGate, checkUslLifecyclePlan, compileUslLifecyclePlan, type PublicationSourceBinding, type UslLifecyclePlan } from './usl/lifecycle-plan.ts';
import { FilePublicationJournal, readPublicationJournalHistory } from './usl/publication-executor.ts';
import { executeAuthorizedUslLifecycle, executeUslLifecycleSimulation, FileUslLifecycleSimulationAdapter, recoverAuthorizedUslLifecycle, recoverUslLifecycleSimulation, validateUslLiveExecutionRequest, type UslLiveExecutionGrant, type UslSimulationGrant } from './usl/lifecycle-simulator.ts';
import { ZetarisUslLifecycleAdapter } from './usl/zetaris-lifecycle-adapter.ts';
import { universeManifests, resolveUniverseManifest, validateThirdPartyUniverseManifest, validateUniverseRegistry, validateUniverseConfig, validateUniverseConfigSet, type UniverseManifest } from './registry/universes.ts';
import { dispatchUniverseAction, resolveUniverseRoute } from './universe-adapters.ts';
import { freshnessHistoryView, readFreshnessHistory, replayFreshnessAttempt } from './reconcile/freshness-history.ts';
import { consumerFreshnessSnapshot } from './reconcile/consumer-freshness.ts';
import { assertFreshnessRelationSupported, resolveFreshnessRelationId } from './reconcile/freshness-scope.ts';
import { assertCapturedRunInputsCurrent, captureLiveRun, captureLocalFixtureRun, captureLocalSnapshotRun, readCapturedRun, registerCapturedRun } from './registry/runs.ts';
import { evaluateSvp1Snapshot, evaluateSvp1Suite, loadSvp1Profiles, resolveSvp1Profile, validateSvp1Manifest, validateSvp1Profiles } from './svp1.ts';
import { validateSvp1LiveManifest, evaluateSvp1Live } from './svp1-live.ts';
import { explainLiveEvaluation, historicalExplanationStatus } from './live-explanations.ts';
import { explainHistoricalCapture } from './historical-explanations.ts';
import { createInstalledComaBridge } from './discovery/coma-provider.ts';
import { runComaDiscovery } from './eval/coma-run.ts';
import { recoverU2ComaFromSnapshot, runU2Agent } from './agent/u2.ts';
import { readSealedBindingBytes } from './usl/sealed-binding.ts';
import { originateUslPlan } from './agent/usl-plan.ts';
import { helpHint, usageFor, wantsHelp } from './agent/cli-help.ts';
import { continueAgentCommand, runAgentCommand, runOfflineAgentCommand } from './agent/cli-run.ts';
import { evaluateAgentLoop } from './eval/agent-eval.ts';
import { writeAgentRunComparison, writeAgentRunReport } from './report/agent-run-report.ts';
try {
  const command = process.argv[2];
  const option = (name:string) => { const eq=process.argv.find(x=>x.startsWith('--'+name+'=')); const i=process.argv.indexOf('--'+name); return eq?.slice(name.length+3)??(i>=0?process.argv[i+1]:undefined); };
  const maxTokensOption = () => { const raw = option('max-tokens'); return raw === undefined ? undefined : Number(raw); };
  if (wantsHelp(process.argv) && usageFor(process.argv)) console.log(usageFor(process.argv));
  else if (command === 'agent-u2') {
    const isContinue = process.argv[3] === 'continue';
    const requestedRunId = option('run-id');
    if (isContinue && !requestedRunId) throw new SafeError('AGENT_CONTINUE_RUN_ID_REQUIRED');
    const runId = requestedRunId ?? `agent-u2-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    await runU2Agent({ runId, task: option('task') ?? 'Prepare a sourced company brief from configured U2 evidence.',
      ...(isContinue ? { continueRunId: requestedRunId! } : {}), resumeAdaptive: process.argv.includes('--resume-adaptive'),
      enrich: process.argv.includes('--enrich'), resume: process.argv.includes('--resume'), decision: option('decide'), actor: option('actor') });
  } else if (command === 'agent-report') {
    const runId = option('run-id');
    if (!runId) throw new SafeError('AGENT_RUN_ID_REQUIRED');
    const out = writeAgentRunReport(runId);
    console.log(JSON.stringify({ runId, files: out.files.map(f => `.concordia/agent-runs/${runId}/${f}`) }));
  } else if (command === 'agent-compare') {
    const runA = option('run-a'), runB = option('run-b');
    if (!runA || !runB) throw new SafeError('AGENT_COMPARE_RUN_IDS_REQUIRED');
    const out = writeAgentRunComparison(runA, runB);
    console.log(JSON.stringify({ runA, runB, files: out.files.map(f => `.concordia/agent-runs/${f}`) }));
  } else if (command === 'agent-usl-plan') {
    // Plan-only: reads a sealed publication envelope, retargets it to an approved namespace and writes the lifecycle plan. No SQL, no grant, no apply.
    const inputPath = option('input'), name = option('name'), namespace = option('namespace'), model = option('model');
    const fingerprint = option('snapshot-fingerprint'), observedAt = option('snapshot-observed-at');
    if (!inputPath || !name || !namespace || !model || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || !!fingerprint !== !!observedAt) throw new SafeError('AGENT_USL_PLAN_ARGUMENTS_REQUIRED');
    const sealed = readJson<any>(inputPath);
    const out = originateUslPlan({ input: sealed.publicationInput, binding: sealed.sourceBinding, target: { namespace, model }, snapshot: fingerprint ? { fingerprint, observedAt: observedAt! } : undefined,
      relation: { fromTable: option('from-table') ?? 'gtfs_trips', fromColumns: (option('from-columns') ?? 'route_id').split(','), toTable: option('to-table') ?? 'gtfs_routes', toColumns: (option('to-columns') ?? 'route_id').split(',') } });
    const files: string[] = [];
    if (out.lifecyclePlan) {
      const inputFile = `.concordia/publication-plans/${name}.input.json`, planFile = `.concordia/publication-plans/${name}.${out.lifecyclePlan.fingerprint.slice(0, 24)}.plan.json`;
      writeJson(inputFile, { publicationManifest: out.publicationManifest, publicationInput: out.publicationInput, sourceBinding: out.sourceBinding, authorizationState: out.authorizationState });
      writeJson(planFile, out.lifecyclePlan);
      files.push(inputFile, planFile);
    }
    console.log(JSON.stringify({ status: out.status, origin: out.origin, label: out.label, reasons: out.reasons, fingerprint: out.lifecyclePlan?.fingerprint ?? null, applyExecuted: false, liveSqlExecuted: false, files }));
    if (out.status === 'NOT_PUBLISHABLE') process.exitCode = 1;
  } else if (command === 'eval-agent') {
    const result = await evaluateAgentLoop();
    writeJson('out/agent-eval/report.json', result);
    console.log(JSON.stringify({ registry: result.registry, runs: result.runs, metrics: result.evaluation.metrics.map(metric => ({ universeId: metric.universeId, methodId: metric.methodId, denominator: metric.denominator, counts: metric.counts })) }));
  } else if (command === 'agent' && process.argv[3] === 'continue') {
    const runId = option('run-id');
    if (!runId) throw new SafeError('AGENT_RUN_ID_REQUIRED');
    await continueAgentCommand(option('universe') ?? '', runId, Number(option('attempt') ?? 1), maxTokensOption());
  } else if (command === 'agent' && process.argv.includes('--offline')) {
    await runOfflineAgentCommand(option('universe') ?? '', { runId: option('run-id'), memory: process.argv.includes('--memory') });
  } else if (command === 'agent') {
    await runAgentCommand(option('universe') ?? '', { runId: option('run-id'), model: !process.argv.includes('--no-model'), coma: !process.argv.includes('--no-coma'), maxTokens: maxTokensOption(), memory: process.argv.includes('--memory') });
  } else if (command === 'discover-coma') {
    const runId = option('run-id');
    if (!runId) throw new SafeError('COMA_RUN_ID_REQUIRED');
    const pythonExecutable = path.join(ROOT, '.concordia', 'python', 'coma-valentine-1.1.0', 'Scripts', 'python.exe');
    const result = await runComaDiscovery({ projectRoot: ROOT, runId, pythonExecutable });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'ERROR' || result.status === 'PARTIAL' ? 1 : 0;
  } else if (command === 'recover-u2-coma') {
    const runId = option('run-id');
    if (!runId) throw new SafeError('AGENT_RUN_ID_REQUIRED');
    const result = await recoverU2ComaFromSnapshot(runId);
    console.log(JSON.stringify(result));
  } else {
  const universeId=option('universe')??'U1';
  const evaluateOrReuseLiveCapture = async (manifest: UniverseManifest, captureRunId: string, registryDir: string | undefined, policyVersion: string | undefined, explain = false) => {
    const requestedRunId = option('run-id');
    if (requestedRunId && requestedRunId !== captureRunId) throw new SafeError('CAPTURE_RUN_ID_MISMATCH');
    const prior = readCapturedRun(captureRunId, { projectRoot: ROOT, registryDir });
    if (prior) {
      if (prior.universeId !== manifest.manifestId) throw new SafeError('RUN_REGISTRY_UNIVERSE_MISMATCH');
      assertCapturedRunInputsCurrent(prior, ROOT, policyVersion);
      const registered = await registerCapturedRun(captureRunId, { projectRoot: ROOT, registryDir });
      return { status: 'CAPTURE_REUSED', runRegistryStatus: registered.status, runId: registered.record.runId, entryId: registered.record.entryId, semanticFingerprint: registered.record.semanticFingerprint, universeId: registered.record.universeId, sourceExecutionMode: registered.record.executionMode, dataOrigin: registered.record.dataOrigin, ...(explain ? { explanation: historicalExplanationStatus(captureRunId, ROOT) } : {}) };
    }
    const result = await evaluateSvp1Live(manifest, { policyVersion, runId: captureRunId });
    const evaluation = {
      manifestId: result.manifestId, version: result.version, universeId: result.manifestId, executionMode: 'LIVE' as const,
      dataOrigin: result.dataOrigin, status: result.status, sourceValidation: result.sourceValidation, contractDeclarations: result.contractDeclarations,
      results: result.decisions.map((item: any) => ({ relationId: item.candidateId, contract: item.contract, evidence: item.evidenceBundle, probeStatus: item.probeStatus, decision: item.decision }))
    };
    const registered = await captureLiveRun(evaluation, captureRunId, { projectRoot: ROOT, registryDir });
    const explanation = explain ? await explainLiveEvaluation(result, { projectRoot: ROOT }) : undefined;
    return { runRegistryStatus: registered.status, entryId: registered.record.entryId, semanticFingerprint: registered.record.semanticFingerprint, ...result, ...(explanation ? { explanation } : {}) };
  };
  const publicationDirectory = path.join(ROOT, '.concordia', 'publication-plans');
  const isSafePublicationFile = (value: string | undefined, kind: 'input' | 'plan') => {
    const suffix = kind === 'input' ? '\\.input\\.json' : '\\.[a-f0-9]{24}\\.plan\\.json';
    if (!value || !new RegExp(`^\\.concordia/publication-plans/[A-Za-z0-9][A-Za-z0-9._-]*${suffix}$`).test(value.replaceAll('\\', '/'))) return false;
    try {
      const concordia = path.join(ROOT, '.concordia');
      const directoryStat = fs.lstatSync(publicationDirectory);
      const filePath = path.resolve(ROOT, value);
      const fileStat = fs.lstatSync(filePath);
      const concordiaStat = fs.lstatSync(concordia);
      if (!concordiaStat.isDirectory() || concordiaStat.isSymbolicLink()) return false;
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) return false;
      const realDirectory = fs.realpathSync(publicationDirectory);
      const realFile = fs.realpathSync(filePath);
      return path.dirname(realFile) === realDirectory && path.resolve(filePath).startsWith(path.resolve(publicationDirectory) + path.sep);
    } catch { return false; }
  };
  const publicationInputPath = (value: string | undefined) => isSafePublicationFile(value, 'input');
  const publicationManifestPath = (value: string | undefined) => isSafePublicationFile(value, 'plan');
  const resolveFreshnessScope=(manifest:UniverseManifest|undefined,requestedRelationId:string)=>{
    if(!manifest)return{universeId,relationId:requestedRelationId,profile:undefined as ReturnType<typeof loadSvp1Profiles>[number]|undefined};
    let profile:ReturnType<typeof loadSvp1Profiles>[number]|undefined;
    try{
      if(manifest.source.adapterId==='local-snapshot')profile=loadSvp1Profiles(manifest.source.configPath??'').find(item=>item.manifestId===manifest.manifestId);
      else if(manifest.source.adapterId==='zetaris-json2-live'){
        const binding=readJson<any>(manifest.source.configPath??'');
        profile=loadSvp1Profiles(binding.profileConfigPath).find(item=>item.manifestId===manifest.source.profileManifestId);
      }
    }catch{profile=undefined;}
    if(!profile)return{universeId:manifest.manifestId,relationId:requestedRelationId,profile};
    return{universeId:manifest.manifestId,relationId:resolveFreshnessRelationId(profile,requestedRelationId),profile};
  };
  const currentPublicationInput=(input:PublicationPlanInput,mode:'RENDER'|'REGENERATE'='RENDER')=>input?.universeId&&input.contract?.id?{...input,freshnessSnapshot:consumerFreshnessSnapshot(input.universeId,[input.contract.id],input.freshnessSnapshot,{mode})}:input;
  const isSafeUniverseJsonPath = (value: string | undefined) => {
    const normalized = value?.replaceAll('\\', '/');
    if (!normalized || !/^universes\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(normalized)) return false;
    try {
      const pieces = normalized.split('/');
      let current = ROOT;
      for (const [index, piece] of pieces.entries()) {
        current = path.join(current, piece);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return false;
        if (index < pieces.length - 1 && !stat.isDirectory()) return false;
        if (index === pieces.length - 1 && !stat.isFile()) return false;
      }
      const realRoot = fs.realpathSync(path.join(ROOT, 'universes'));
      const realFile = fs.realpathSync(path.join(ROOT, ...pieces));
      const relative = path.relative(realRoot, realFile);
      return Boolean(relative) && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    } catch { return false; }
  };
  if(command==='freshness'){
    const action=process.argv[3],relationId=option('relation');
    if(!relationId)throw new SafeError('FRESHNESS_RELATION_REQUIRED');
    const freshnessScope=resolveFreshnessScope(resolveUniverseManifest(universeId),relationId);
    if(action==='history'){
      const ttlRaw=option('ttl-ms'),ttl=ttlRaw===undefined?undefined:Number(ttlRaw);if(ttlRaw!==undefined&&(!Number.isSafeInteger(ttl)||ttl!<0))throw new SafeError('FRESHNESS_TTL_INVALID');
      console.log(JSON.stringify({status:'HISTORY',universeId:freshnessScope.universeId,relationId:freshnessScope.relationId,...(relationId!==freshnessScope.relationId?{requestedRelationId:relationId}:{}),attempts:freshnessHistoryView(freshnessScope.universeId,freshnessScope.relationId,Date.now(),ttl)}));
    }else if(action==='replay'){
      const attemptId=option('attempt');if(!attemptId)throw new SafeError('FRESHNESS_ATTEMPT_REQUIRED');
      console.log(JSON.stringify(replayFreshnessAttempt(freshnessScope.universeId,freshnessScope.relationId,attemptId)));
    }else if(action==='revalidate'){
      const mode=option('mode');if(mode!=='LOCAL'&&mode!=='LIVE')throw new SafeError('FRESHNESS_EXECUTION_MODE_REQUIRED');
      const manifest=resolveUniverseManifest(universeId);if(!manifest)throw new SafeError('UNIVERSE_NOT_REGISTERED');
      const freshnessScope=resolveFreshnessScope(manifest,relationId);
      const route=resolveUniverseRoute(manifest,manifest.source.adapterId==='local-files'||manifest.source.adapterId==='local-snapshot'?'eval':'probe');
      if(route==='local-snapshot'||route==='zetaris-json2-live')assertFreshnessRelationSupported(freshnessScope.profile,relationId);
      const localRoutes=new Set(['local-fixture','local-snapshot']),liveRoutes=new Set(['zetaris-u1-legacy','zetaris-generic','zetaris-json2-live']);
      if(mode==='LOCAL'&&!localRoutes.has(route)||mode==='LIVE'&&!liveRoutes.has(route))throw new SafeError('FRESHNESS_REVALIDATE_ROUTE_UNSUPPORTED');
      const requestedRunId=option('run-id'),requestedCaptureId=option('capture-run');
      if(requestedRunId&&requestedCaptureId&&requestedRunId!==requestedCaptureId)throw new SafeError('CAPTURE_RUN_ID_MISMATCH');
      const runId=requestedRunId??requestedCaptureId??`freshness-${Date.now()}-${createHash('sha256').update(universeId+'|'+relationId).digest('hex').slice(0,12)}`;
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId))throw new SafeError('FRESHNESS_RUN_ID_INVALID');
      const registryOptions={projectRoot:ROOT,...(option('run-registry-dir')?{registryDir:option('run-registry-dir')}:{})};
      const capturedPrior=readCapturedRun(runId,registryOptions);
      if(capturedPrior){if(capturedPrior.universeId!==manifest.manifestId)throw new SafeError('RUN_REGISTRY_UNIVERSE_MISMATCH');const registered=await registerCapturedRun(capturedPrior.runId,registryOptions);console.log(JSON.stringify({status:'CAPTURE_REUSED',runRegistryStatus:registered.status,runId:registered.record.runId,entryId:registered.record.entryId,universeId:registered.record.universeId,sourceExecutionMode:registered.record.executionMode,dataOrigin:registered.record.dataOrigin}));}
      else {
      if(mode==='LIVE')loadLocalEnv();
      const priorAttemptIds=new Set(readFreshnessHistory(freshnessScope.universeId,freshnessScope.relationId).map(item=>item.attemptId));
      const actionForRoute=localRoutes.has(route)||route==='zetaris-json2-live'?'eval':'probe';
      const output:any=await dispatchUniverseAction(manifest,universeId,actionForRoute,{runId,policyVersion:option('policy-version'),freshnessRevalidate:true,relationId});
      const rows=Array.isArray(output)?output.map((item:any)=>({relationId:item.relation?.id??item.relationId,contract:item.relationContract,evidence:item.typedEvidence,probeStatus:item.status==='PASS'?'COMPLETE':item.status,decision:item.decision})):Array.isArray(output?.probes)?output.probes.map((item:any)=>({relationId:item.relation?.id??item.relationId,contract:item.relationContract,evidence:item.typedEvidence,probeStatus:item.status==='PASS'?'COMPLETE':item.status,decision:item.decision})):Array.isArray(output?.results)?output.results.map((item:any)=>({relationId:item.relationId,contract:item.contract,evidence:item.evidence,probeStatus:item.probeStatus,decision:item.decision})):Array.isArray(output?.decisions)?output.decisions.map((item:any)=>({relationId:item.relationContractRef??item.candidateId,contract:item.contract,evidence:item.evidenceBundle,probeStatus:item.probeStatus,decision:item.decision})):[];
      const captured=rows.filter((item:any)=>item.contract&&item.evidence&&item.decision);
      const origins:string[]=[...new Set<string>(captured.map((item:any)=>{const value=item.evidence.runRef.dataOrigin;return typeof value==='string'?value:String(value?.label??'UNKNOWN');}))];
      const dataOrigin:string=origins.length===1?String(origins[0]):origins.length?'MIXED':manifest.source.dataOrigin;
      const evaluation:any={manifestId:manifest.manifestId,version:manifest.version,universeId:manifest.manifestId,executionMode:mode as 'LIVE'|'LOCAL',dataOrigin,status:captured.length&&captured.every((item:any)=>item.probeStatus==='COMPLETE')?'COMPLETE':'PARTIAL',results:captured,...(output?.sourceValidation?{sourceValidation:output.sourceValidation}:{}),...(output?.contractDeclarations?{contractDeclarations:output.contractDeclarations}:{})};
      const registryResult=mode==='LIVE'?await captureLiveRun(evaluation,runId,registryOptions):route==='local-snapshot'?await captureLocalSnapshotRun(evaluation,runId,registryOptions):await captureLocalFixtureRun(evaluation,runId,registryOptions);
      const newAttempts=readFreshnessHistory(freshnessScope.universeId,freshnessScope.relationId).filter(item=>!priorAttemptIds.has(item.attemptId));
      console.log(JSON.stringify({status:evaluation.status==='COMPLETE'?'REVALIDATED':'INCOMPLETE',runId,runRegistryStatus:registryResult.status,entryId:registryResult.record.entryId,universeId:freshnessScope.universeId,relationId:freshnessScope.relationId,...(relationId!==freshnessScope.relationId?{requestedRelationId:relationId}:{}),attemptRefs:newAttempts.map(item=>item.attemptId)}));
      }
    }else throw new SafeError('FRESHNESS_ACTION_INVALID');
  } else if (command === 'universe' && process.argv[3] === 'explain') {
    const input = option('input'), inputSha256 = option('input-sha256'), taskId = option('task-id');
    const prepareOnly = process.argv.includes('--prepare-only'), dispatch = process.argv.includes('--dispatch');
    if (!input || !inputSha256 || !taskId || prepareOnly === dispatch) throw new SafeError('HISTORICAL_EXPLANATION_ARGUMENTS_REQUIRED');
    const result = await explainHistoricalCapture(input, inputSha256, taskId, universeId, { phase: dispatch ? 'dispatch' : 'prepare' });
    console.log(JSON.stringify(result));
    if (result.explanationStatus === 'ERROR') process.exitCode = 1;
  } else if (command === 'publication' && process.argv[3] === 'lifecycle-plan') {
    const inputPath = option('input');
    if (!publicationInputPath(inputPath)) throw new SafeError('INVALID_PUBLICATION_PLAN_PATH');
    const envelope = readJson<{ publicationManifest: PublicationManifest; publicationInput: PublicationPlanInput; sourceBinding: PublicationSourceBinding }>(inputPath!);
    const plan = compileUslLifecyclePlan(envelope.publicationManifest, envelope.publicationInput, envelope.sourceBinding);
    console.log(JSON.stringify({ status: plan.status, fingerprint: plan.fingerprint, executable: false, plan }));
  } else if (command === 'publication' && process.argv[3] === 'lifecycle-check') {
    const inputPath = option('input'), planPath = option('plan');
    if (!publicationInputPath(inputPath) || !publicationManifestPath(planPath)) throw new SafeError('INVALID_PUBLICATION_PLAN_PATH');
    const envelope = readJson<{ publicationManifest: PublicationManifest; publicationInput: PublicationPlanInput; sourceBinding: PublicationSourceBinding }>(inputPath!);
    const plan = readJson<UslLifecyclePlan>(planPath!);
    const check = checkUslLifecyclePlan(plan, envelope.publicationManifest, envelope.publicationInput, envelope.sourceBinding);
    const applyGate = assessUslLifecycleApplyGate(plan, check);
    console.log(JSON.stringify({ status: check.status, staleInputs: check.staleInputs, applyStatus: applyGate.status, canApply: false, reasons: applyGate.reasons }));
    if (check.status === 'STALE') process.exitCode = 1;
  } else if (command === 'publication' && process.argv[3] === 'lifecycle-simulate') {
    const inputPath = option('input'), planPath = option('plan'), statePath = option('simulation-state'), journalPath = option('journal');
    const action = option('action'), runId = option('run-id');
    if (!publicationInputPath(inputPath) || !publicationManifestPath(planPath) || !statePath || !journalPath || !runId || !['apply', 'reuse', 'recover'].includes(action ?? '')) throw new SafeError('INVALID_LIFECYCLE_SIMULATION_ARGUMENTS');
    const envelope = readJson<{ publicationManifest: PublicationManifest; publicationInput: PublicationPlanInput; sourceBinding: PublicationSourceBinding; authorizationGrant?: UslSimulationGrant }>(inputPath!);
    if (!envelope.authorizationGrant) throw new SafeError('EXACT_LOCAL_SYNTHETIC_GRANT_REQUIRED');
    const plan = readJson<UslLifecyclePlan>(planPath!);
    const adapter = new FileUslLifecycleSimulationAdapter(path.resolve(ROOT, statePath), ROOT);
    const journal = new FilePublicationJournal(path.resolve(ROOT, journalPath), ROOT);
    const result = action === 'recover'
      ? await recoverUslLifecycleSimulation(plan, envelope.sourceBinding, envelope.authorizationGrant, adapter, journal, runId)
      : await executeUslLifecycleSimulation(plan, envelope.publicationManifest, envelope.publicationInput, envelope.sourceBinding, envelope.authorizationGrant, adapter, journal, runId, Date.now(), action === 'reuse' ? 'REUSE' : 'APPLY');
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } else if (command === 'publication' && ['lifecycle-apply', 'lifecycle-reuse', 'lifecycle-recover'].includes(process.argv[3] ?? '')) {
    const action = process.argv[3], inputPath = option('input'), planPath = option('plan'), dialectPath = option('dialect-evidence'), journalPath = option('journal'), runId = option('run-id');
    if (!publicationInputPath(inputPath) || !publicationManifestPath(planPath) || !publicationManifestPath(dialectPath) || !journalPath || !runId || !/^[-A-Za-z0-9._]{1,64}$/.test(runId) || journalPath.replaceAll('\\', '/') !== `.concordia/publication-runs/${runId}/journal.jsonl`) throw new SafeError('INVALID_LIVE_LIFECYCLE_ARGUMENTS');
    const envelope = readJson<{ publicationManifest: PublicationManifest; publicationInput: PublicationPlanInput; sourceBinding: PublicationSourceBinding; liveAuthorizationGrant?: UslLiveExecutionGrant }>(inputPath!);
    const plan = readJson<UslLifecyclePlan>(planPath!);
    const rawBindingPath = path.join(ROOT, 'universes', 'svp1-live-bindings.json');
    const rawBindingBytes = readSealedBindingBytes(rawBindingPath);
    const bindingDocument = JSON.parse(rawBindingBytes.toString('utf8'));
    const dialectBytes = fs.readFileSync(path.resolve(ROOT, dialectPath!));
    const grant = envelope.liveAuthorizationGrant;
    const issue = grant ? validateUslLiveExecutionRequest(plan, envelope.publicationManifest, envelope.publicationInput, envelope.sourceBinding, rawBindingBytes, grant, dialectBytes) : 'EXACT_LIVE_PUBLICATION_GRANT_REQUIRED';
    if (issue) {
      console.log(JSON.stringify({ status: 'REJECTED', passed: false, fingerprint: plan?.fingerprint ?? '', reason: issue, sourceExecutionMode: plan?.executionMode ?? 'UNKNOWN', executionMode: 'LIVE', liveSqlExecuted: false }));
      process.exitCode = 1;
    } else {
      // All plan, grant, sealed-binding, and dialect checks pass before environment loading or client construction.
      loadLocalEnv();
      const client = new Zetaris();
      const adapter = new ZetarisUslLifecycleAdapter(plan, grant!, client, {}, runId, ROOT, bindingDocument, envelope.publicationInput);
      const journal = new FilePublicationJournal(path.resolve(ROOT, journalPath), ROOT);
      const result = action === 'lifecycle-recover'
        ? await recoverAuthorizedUslLifecycle(plan, envelope.publicationManifest, envelope.publicationInput, envelope.sourceBinding, rawBindingBytes, dialectBytes, grant!, adapter, journal, runId)
        : await executeAuthorizedUslLifecycle(plan, envelope.publicationManifest, envelope.publicationInput, envelope.sourceBinding, rawBindingBytes, dialectBytes, grant!, adapter, journal, runId, Date.now(), action === 'lifecycle-reuse' ? 'REUSE' : 'APPLY');
      console.log(JSON.stringify({ ...result, sourceExecutionMode: plan.executionMode, executionMode: 'LIVE' }));
      if (!result.passed) process.exitCode = 1;
    }
  } else if (command === 'publication' && process.argv[3] === 'history') {
    const journalPath = option('journal');
    if (!journalPath) throw new SafeError('PUBLICATION_JOURNAL_PATH_REQUIRED');
    const events = readPublicationJournalHistory(path.resolve(ROOT, journalPath), ROOT);
    console.log(JSON.stringify({ status: 'HISTORY', count: events.length, events }));
  } else if (command === 'publication' && process.argv[3] === 'plan') {
    const inputPath = option('input');
    if (!publicationInputPath(inputPath)) throw new SafeError('INVALID_PUBLICATION_PLAN_PATH');
    const input = currentPublicationInput(readJson<PublicationPlanInput>(inputPath!),'REGENERATE');
    const manifest = compilePublicationPlan(input);
    const outputPath = inputPath!.replace(/\.input\.json$/, '.' + manifest.fingerprint.slice(0, 24) + '.plan.json');
    writeJson(outputPath, manifest);
    console.log(JSON.stringify({ status: 'PLANNED', planId: manifest.manifestId, fingerprint: manifest.fingerprint, eligibility: manifest.eligibility, executable: manifest.executable, executionStatus: manifest.lifecycle.executionStatus, outputPath }));
  } else if (command === 'publication' && process.argv[3] === 'check') {
    const inputPath = option('input'), planPath = option('plan');
    if (!publicationInputPath(inputPath) || !publicationManifestPath(planPath)) throw new SafeError('INVALID_PUBLICATION_PLAN_PATH');
    const input = currentPublicationInput(readJson<PublicationPlanInput>(inputPath!));
    const manifest = readJson<PublicationManifest>(planPath!);
    const preconditions = checkPublicationPlanPreconditions(manifest, input);
    const applyGate = assessPublicationApplyPreconditions(manifest, input, { explicitAuthorization: false, dialectConfirmed: false });
    const output = { status: preconditions.status, diagnostic: preconditions.diagnostic, staleInputs: preconditions.staleInputs, planId: manifest?.manifestId ?? null, fingerprint: manifest?.fingerprint ?? null, applyStatus: applyGate.status, canApply: false as const };
    console.log(JSON.stringify(output));
    if (preconditions.status === 'STALE') process.exitCode = 1;
  } else if (command === 'universe' && process.argv[3] === 'validate') {
    const manifestPath = option('manifest');
    if (manifestPath && !isSafeUniverseJsonPath(manifestPath)) throw new SafeError('INVALID_MANIFEST_PATH');
    const candidate = manifestPath ? readJson<UniverseManifest>(manifestPath) : undefined;
    const manifests = candidate ? [...universeManifests, candidate] : [...universeManifests];
    const issues = manifestPath ? validateThirdPartyUniverseManifest(candidate!, universeManifests) : validateUniverseRegistry(universeManifests);
    const configEntries: { manifest: UniverseManifest; config: unknown }[] = [];
    for (const manifest of manifests) {
      const source = (manifest as any)?.source;
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      if (typeof source.sourceId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(source.sourceId) || !['zetaris', 'zetaris-json2-live', 'local-files', 'local-snapshot', 'madi-schema', 'manifest-only'].includes(source.adapterId) || !['UNKNOWN', 'PUBLIC', 'USER', 'SYNTHETIC'].includes(source.dataOrigin)) continue;
      if (source.adapterId === 'manifest-only') continue;
      if (!isSafeUniverseJsonPath(source.configPath)) { issues.push({ path: `configs.${(manifest as any).manifestId ?? 'unknown'}.source.configPath`, code: 'INVALID_CONFIG_PATH' }); continue; }
      let config: unknown;
      try { config = readJson(source.configPath); }
      catch { issues.push({ path: `configs.${(manifest as any).manifestId ?? 'unknown'}.source.configPath`, code: 'CONFIG_JSON_INVALID' }); continue; }
      if (source.adapterId === 'zetaris-json2-live') {
        issues.push(...validateSvp1LiveManifest(manifest, config));
        continue;
      }
      if (source.adapterId === 'local-snapshot') {
        issues.push(...validateSvp1Profiles(config as any));
        issues.push(...validateSvp1Manifest(manifest, config as any));
        continue;
      }
      issues.push(...validateUniverseConfig(manifest, config));
      configEntries.push({ manifest, config });
    }
    issues.push(...validateUniverseConfigSet(configEntries));
    console.log(JSON.stringify({ status: issues.length ? 'INVALID' : 'VALID', manifests: manifestPath ? [manifestPath] : universeManifests.map(manifest => manifest.manifestId), issues }));
    if (issues.length) process.exitCode = 1;
    else process.exitCode = 0;
  } else if (command === 'universe' && process.argv[3] === 'run-record') {
    const runId = option('run-id'), registryDir = option('run-registry-dir');
    if (!runId) throw new SafeError('RUN_REGISTRY_RUN_ID_REQUIRED');
    const result = await registerCapturedRun(runId, { projectRoot: ROOT, registryDir });
    console.log(JSON.stringify({ status: result.status, runId: result.record.runId, entryId: result.record.entryId, semanticFingerprint: result.record.semanticFingerprint, universeId: result.record.universeId, sourceExecutionMode: result.record.executionMode, dataOrigin: result.record.dataOrigin }));
  } else if (command === 'universe' && process.argv[3] === 'evaluate') {
    const captureRunId = option('capture-run'), registryDir = option('run-registry-dir'), policyVersion = option('policy-version');
    const explain = process.argv.includes('--explain');
    if (explain && !captureRunId) throw new SafeError('EXPLANATION_CAPTURE_RUN_REQUIRED');
    const requestedManifest=resolveUniverseManifest(universeId);
    if (explain && requestedManifest?.source.adapterId !== 'zetaris-json2-live') throw new SafeError('EXPLANATION_JSON2_LIVE_ONLY');
    if (process.argv.includes('--all-svp1')) {
      if(captureRunId)throw new SafeError('SVP1_SUITE_CAPTURE_UNSUPPORTED');
      const result = await evaluateSvp1Suite({ policyVersion, runId: option('run-id') });
      console.log(JSON.stringify({ ...result, status: (result as any).status ?? 'EVALUATED' }));
    } else if (requestedManifest?.source.adapterId === 'zetaris-json2-live') {
      if (captureRunId) console.log(JSON.stringify(await evaluateOrReuseLiveCapture(requestedManifest, captureRunId, registryDir, policyVersion, explain)));
      else if (explain) throw new SafeError('EXPLANATION_CAPTURE_RUN_REQUIRED');
      else { const result = await evaluateSvp1Live(requestedManifest, { policyVersion, runId: option('run-id') }); console.log(JSON.stringify({ ...result, status: (result as any).status ?? 'EVALUATED' })); }
    } else if (requestedManifest?.source.adapterId === 'local-snapshot' && requestedManifest.capabilities.includes('LOCAL_EVALUATION') && requestedManifest.capabilities.includes('RELATION_EVALUATION')) {
      const snapshotManifest = requestedManifest;
      if (resolveUniverseRoute(snapshotManifest, 'eval') !== 'local-snapshot') throw new SafeError('SVP1_PROFILE_NOT_REGISTERED');
      const selectedProfile=resolveSvp1Profile(universeId);if(!selectedProfile||selectedProfile.manifestId!==snapshotManifest.manifestId)throw new SafeError('SVP1_PROFILE_NOT_REGISTERED');
      const manifestIssues = validateSvp1Manifest(snapshotManifest);
      if (manifestIssues.length) throw new SafeError('SVP1_MANIFEST_INVALID', undefined, JSON.stringify(manifestIssues));
      if (captureRunId) {
        const requestedRunId=option('run-id');if(requestedRunId&&requestedRunId!==captureRunId)throw new SafeError('CAPTURE_RUN_ID_MISMATCH');
        const prior = readCapturedRun(captureRunId, { projectRoot: ROOT, registryDir });
        if (prior) {
          if (prior.universeId !== snapshotManifest.manifestId) throw new SafeError('RUN_REGISTRY_UNIVERSE_MISMATCH');
          assertCapturedRunInputsCurrent(prior, ROOT, policyVersion);
          const registered = await registerCapturedRun(captureRunId, { projectRoot: ROOT, registryDir });
          console.log(JSON.stringify({status:'CAPTURE_REUSED',runRegistryStatus:registered.status,runId:registered.record.runId,entryId:registered.record.entryId,semanticFingerprint:registered.record.semanticFingerprint,universeId:registered.record.universeId,sourceExecutionMode:registered.record.executionMode,dataOrigin:registered.record.dataOrigin}));
        } else {
          const result = await evaluateSvp1Snapshot(universeId, { policyVersion, runId: option('run-id') ?? captureRunId });
          const origins=[...new Set(result.predictions.map((item:any)=>item.dataOrigin).filter((origin:any)=>typeof origin==='string'))];
          const registryEvaluation={manifestId:result.manifestId,version:result.version,universeId:result.manifestId,executionMode:'LOCAL' as const,dataOrigin:origins.length===1?origins[0]:'UNKNOWN',results:result.decisions.map((item:any)=>({relationId:item.candidateId,contract:item.contract,evidence:item.evidenceBundle,probeStatus:item.probeStatus,decision:item.decision}))};
          const registered=await captureLocalSnapshotRun(registryEvaluation,captureRunId,{projectRoot:ROOT,registryDir});
          console.log(JSON.stringify({status:'EVALUATED',runRegistryStatus:registered.status,entryId:registered.record.entryId,semanticFingerprint:registered.record.semanticFingerprint,...result}));
        }
      } else {
        const result = await evaluateSvp1Snapshot(universeId, { policyVersion, runId: option('run-id') });
        console.log(JSON.stringify({ ...result, status: (result as any).status ?? 'EVALUATED' }));
      }
    } else if (captureRunId) {
      const prior = readCapturedRun(captureRunId, { projectRoot: ROOT, registryDir });
      if (prior) {
        const requestedManifest = resolveUniverseManifest(universeId);
        if (!requestedManifest || requestedManifest.manifestId !== prior.universeId) throw new SafeError('RUN_REGISTRY_UNIVERSE_MISMATCH');
        assertCapturedRunInputsCurrent(prior, ROOT, policyVersion);
        const registered = await registerCapturedRun(captureRunId, { projectRoot: ROOT, registryDir });
        console.log(JSON.stringify({ status: 'CAPTURE_REUSED', runRegistryStatus: registered.status, runId: registered.record.runId, entryId: registered.record.entryId, semanticFingerprint: registered.record.semanticFingerprint, universeId: registered.record.universeId, sourceExecutionMode: registered.record.executionMode, dataOrigin: registered.record.dataOrigin }));
      } else {
        const result = await evaluateLocalFixtureUniverse(universeId, policyVersion);
        const registered = await captureLocalFixtureRun(result, captureRunId, { projectRoot: ROOT, registryDir });
        console.log(JSON.stringify({ status: 'EVALUATED', runRegistryStatus: registered.status, runId: registered.record.runId, entryId: registered.record.entryId, semanticFingerprint: registered.record.semanticFingerprint, ...result, results: result.results.map(item => ({ relationId: item.relationId, probeStatus: item.probeStatus, verdict: item.decision.verdict, reasonCodes: item.decision.reasonCodes, evidenceBundleRef: item.evidence.evidenceBundleId, contractVersion: item.contract.contractVersion })) }));
      }
    } else {
      const result = await evaluateLocalFixtureUniverse(universeId, policyVersion);
      console.log(JSON.stringify({ status: 'EVALUATED', ...result, results: result.results.map(item => ({ relationId: item.relationId, probeStatus: item.probeStatus, verdict: item.decision.verdict, reasonCodes: item.decision.reasonCodes, evidenceBundleRef: item.evidence.evidenceBundleId, contractVersion: item.contract.contractVersion })) }));
    }
  } else {
  const selectedManifest = resolveUniverseManifest(universeId);
  if (!selectedManifest) throw new SafeError('INVALID_UNIVERSE');
  if (command === 'eval' && process.argv.includes('--explain')) {
    if (selectedManifest.source.adapterId !== 'zetaris-json2-live') throw new SafeError('EXPLANATION_JSON2_LIVE_ONLY');
    if (!option('capture-run')) throw new SafeError('EXPLANATION_CAPTURE_RUN_REQUIRED');
  }
  if(command==='register'&&universeId==='U2')assertRegistrationContact();
  if (['smoke','test-connection','route-preview','discover','probe','critic','usl','demo','complete-llm','register','register-madi-p5'].includes(command) && !(command==='demo'&&process.env.SAMPLE_MODE==='true') && !(command==='register'&&universeId==='U3') && !(command==='probe'&&selectedManifest.source.adapterId==='zetaris-json2-live')) loadLocalEnv();
  if (command === 'smoke' || command === 'test-connection') await connection(command === 'smoke');
  else if (command === 'route-preview') await routePreviews();
  else if (command === 'register') {if(universeId==='U3')await registerMadi();else await register(universeId);}
  else if(command==='register-madi-p5'){const result=await registerMadiDomains();console.log('MaDI P5',result.status,Object.keys(result.domains).length,'domains; files not selected');}
  else if(command==='eval'&&selectedManifest.source.adapterId==='zetaris-json2-live'&&(option('capture-run')||process.argv.includes('--explain'))){
    if(process.argv.includes('--explain')&&!option('capture-run'))throw new SafeError('EXPLANATION_CAPTURE_RUN_REQUIRED');
    const result = await evaluateOrReuseLiveCapture(selectedManifest, option('capture-run')!, option('run-registry-dir'), option('policy-version'), process.argv.includes('--explain'));
    console.log(JSON.stringify(result));
  }
  else if(command==='eval'&&option('capture-run')&&selectedManifest.source.adapterId==='local-snapshot'){
    const captureRunId=option('capture-run')!,registryDir=option('run-registry-dir'),policyVersion=option('policy-version');
    const requestedRunId=option('run-id');if(requestedRunId&&requestedRunId!==captureRunId)throw new SafeError('CAPTURE_RUN_ID_MISMATCH');
    if(!resolveSvp1Profile(universeId))throw new SafeError('SVP1_PROFILE_NOT_REGISTERED');
    const prior=readCapturedRun(captureRunId,{projectRoot:ROOT,registryDir});
    if(prior){if(prior.universeId!==selectedManifest.manifestId)throw new SafeError('RUN_REGISTRY_UNIVERSE_MISMATCH');assertCapturedRunInputsCurrent(prior,ROOT,policyVersion);const registered=await registerCapturedRun(captureRunId,{projectRoot:ROOT,registryDir});console.log(JSON.stringify({status:'CAPTURE_REUSED',runRegistryStatus:registered.status,runId:registered.record.runId,entryId:registered.record.entryId,semanticFingerprint:registered.record.semanticFingerprint,universeId:registered.record.universeId,sourceExecutionMode:registered.record.executionMode,dataOrigin:registered.record.dataOrigin}));}
    else{const result=await evaluateSvp1Snapshot(universeId,{policyVersion,runId:option('run-id')??captureRunId});const origins=[...new Set(result.predictions.map((item:any)=>item.dataOrigin).filter((origin:any)=>typeof origin==='string'))];const registryEvaluation={manifestId:result.manifestId,version:result.version,universeId:result.manifestId,executionMode:'LOCAL' as const,dataOrigin:origins.length===1?origins[0]:'UNKNOWN',results:result.decisions.map((item:any)=>({relationId:item.candidateId,contract:item.contract,evidence:item.evidenceBundle,probeStatus:item.probeStatus,decision:item.decision}))};const registered=await captureLocalSnapshotRun(registryEvaluation,captureRunId,{projectRoot:ROOT,registryDir});console.log(JSON.stringify({status:'EVALUATED',runRegistryStatus:registered.status,entryId:registered.record.entryId,semanticFingerprint:registered.record.semanticFingerprint,...result}));}
  }
  else if (command === 'discover' || command === 'probe' || command === 'eval') await dispatchUniverseAction(selectedManifest,universeId,command,{runId:option('run-id'),policyVersion:option('policy-version'),...(command==='discover'&&process.argv.includes('--coma')?{coma:createInstalledComaBridge(path.join(ROOT,'.concordia','python','coma-valentine-1.1.0','Scripts','python.exe'),ROOT)}:{})});
  else if (command === 'critic') { const rid=option('relationId'); const c=await criticize(universeId,{includeExcluded:process.argv.includes('--include-cost-excluded'),relationIds:rid?[rid]:undefined,force:process.argv.includes('--force')}); console.log('Crítica',universeId,JSON.stringify({confirmed:c.confirmed,degraded:c.degraded,insufficient:c.insufficient,skipped:c.skipped})); }
  else if (command === 'eval-critic') { console.log(JSON.stringify(evaluateCritic(universeId))); }
  else if (command === 'publish-decisions') { const result=await publishDecisions(universeId,process.argv.includes('--dry-run')); console.log('Decisiones',universeId,JSON.stringify(result)); }
  else if (command === 'verdict') verdicts();

  else if (command === 'usl') { if(process.argv.includes('--minimal'))await usl();else await completeUsl(universeId); }
  else if (command === 'usl-dossier') {const result=uslDossier(universeId);console.log(result.cacheLabel,'USL dossier',universeId,'FK',result.foreignKeys.length,'negative',result.forbidden.length);}
  else if (command === 'hmem-smoke') hmemSmoke();
  else if (command === 'complete-llm') await completeLlm();
  else if (command === 'reconcile') reconcile(universeId);
  else if (command === 'review') await review(universeId,option('decide'),option('note'),option('actor'),process.argv.includes('--list'));
  else if (command === 'demo') await demo(universeId);
  else throw new SafeError('COMMAND_PENDING_IMPLEMENTATION');
  }
  }
} catch (error) { console.error('FAIL', JSON.stringify(failure(error))); const hint = helpHint(process.argv); if (hint && error instanceof SafeError) console.error(hint); process.exitCode = 1; }
