import type { UniverseCapability, UniverseManifest } from './registry/universes.ts';
import { SafeError } from './runtime.ts';
import { discover } from './discovery/index.ts';
import { probe } from './probe/index.ts';
import { verdicts } from './probe/verdicts.ts';
import { evaluate } from './eval.ts';
import { discoverUniverse, probeUniverse, evaluateUniverse, evaluateLocalFixtureUniverse } from './universe-pipeline.ts';
import { discoverMappings, probeMappings, evaluateMadiTyped } from './madi.ts';
import { evaluateSvp1Snapshot, resolveSvp1Profile, validateSvp1Manifest } from './svp1.ts';
import { evaluateSvp1Live } from './svp1-live.ts';
import type { Json2LiveBindingDocument } from './relations/adapters/zetaris-json2.ts';
import type { ProbeAdapter } from './relations/probes.ts';

export type UniverseAction = 'discover' | 'probe' | 'eval';
export type UniverseRoute = 'zetaris-u1-legacy' | 'zetaris-generic' | 'madi-schema' | 'local-fixture' | 'local-snapshot' | 'zetaris-json2-live';

const requiredCapability: Record<UniverseAction, UniverseCapability> = {
  discover: 'DISCOVERY', probe: 'BOUNDED_RELATION_PROBE', eval: 'RELATION_EVALUATION'
};
const legacyAlias = (manifest: UniverseManifest) => manifest.aliases.find(alias => ['U1', 'U2', 'U3'].includes(alias));

/** Pure route selection: live handlers are selected by validated adapter and declared capability. */
export function resolveUniverseRoute(manifest: UniverseManifest, action: UniverseAction): UniverseRoute {
  if (!manifest.capabilities.includes(requiredCapability[action])) throw new SafeError(`UNIVERSE_${requiredCapability[action]}_CAPABILITY_REQUIRED`);
  switch (manifest.source.adapterId) {
    case 'zetaris':
      return legacyAlias(manifest) === 'U1' ? 'zetaris-u1-legacy' : 'zetaris-generic';
    case 'zetaris-json2-live':
      if (!manifest.capabilities.includes('LIVE_RELATION_PROBE')) throw new SafeError('LIVE_RELATION_PROBE_CAPABILITY_REQUIRED');
      if (action !== 'eval' && action !== 'probe') throw new SafeError('JSON2_LIVE_ACTION_UNSUPPORTED');
      return 'zetaris-json2-live';
    case 'madi-schema':
      if (!manifest.capabilities.includes('SCHEMA_MATCHING')) throw new SafeError('SCHEMA_MATCHING_CAPABILITY_REQUIRED');
      return 'madi-schema';
    case 'local-files':
      if (action !== 'eval' || manifest.source.dataOrigin !== 'SYNTHETIC' || !manifest.capabilities.includes('LOCAL_EVALUATION')) throw new SafeError('LOCAL_FIXTURE_EVALUATION_CAPABILITY_REQUIRED');
      return 'local-fixture';
    case 'local-snapshot':
      if (action !== 'eval' || !manifest.capabilities.includes('LOCAL_EVALUATION')) throw new SafeError('LOCAL_SNAPSHOT_EVALUATION_CAPABILITY_REQUIRED');
      return 'local-snapshot';
    case 'manifest-only':
      throw new SafeError('UNIVERSE_MANIFEST_ONLY');
  }
}

/** Adapter handlers retain legacy behavior while the CLI core dispatches only by manifest capability. */
export async function dispatchUniverseAction(manifest: UniverseManifest, requestedId: string, action: UniverseAction, options: { coma?: import('./discovery/coma-provider.ts').ComaBridge; runId?: string; policyVersion?: string; now?: () => string; binding?: Json2LiveBindingDocument; adapter?: ProbeAdapter; freshnessRevalidate?:boolean; relationId?:string } = {}): Promise<unknown> {
  const route = resolveUniverseRoute(manifest, action);
  if (route === 'zetaris-json2-live') {
    const output = await evaluateSvp1Live(manifest, { ...options, persistFreshness:options.freshnessRevalidate, relationIds:options.relationId?[options.relationId]:undefined });
    console.log(JSON.stringify({ ...output, status: (output as any).status ?? 'EVALUATED' }));
    return output;
  }
  if (route === 'local-snapshot') {
    const profile = resolveSvp1Profile(requestedId);
    if (!profile || profile.manifestId !== manifest.manifestId) throw new SafeError('SVP1_PROFILE_MANIFEST_MISMATCH');
    const issues = validateSvp1Manifest(manifest);
    if (issues.length) throw new SafeError('SVP1_MANIFEST_INVALID', undefined, JSON.stringify(issues));
    const output = await evaluateSvp1Snapshot(requestedId, { ...options, persistFreshness:options.freshnessRevalidate, relationIds:options.relationId?[options.relationId]:undefined });
    console.log(JSON.stringify({ ...output, status: (output as any).status ?? 'EVALUATED' }));
    return output;
  }
  const canonicalId = legacyAlias(manifest) ?? requestedId;
  if (route === 'zetaris-u1-legacy') {
    if (action === 'discover') return discover(options.coma ? { coma: options.coma } : undefined);
    if (action === 'probe') { const result = options.freshnessRevalidate&&options.relationId?await probe({candidateIds:[options.relationId]},{persist:false,recordFreshness:true,now:options.now}):await probe(); if(!options.freshnessRevalidate)verdicts(); return result; }
    return evaluate();
  }
  if (route === 'zetaris-generic') {
    if (action === 'discover') return discoverUniverse(canonicalId);
    if (action === 'probe') return options.freshnessRevalidate&&options.relationId?probeUniverse(canonicalId,{persist:false,recordFreshness:true,relationIds:[options.relationId],now:options.now}):probeUniverse(canonicalId);
    return evaluateUniverse(canonicalId);
  }
  if (route === 'madi-schema') {
    if (action === 'discover') return discoverMappings(canonicalId);
    if (action === 'probe') return probeMappings(canonicalId);
    return evaluateMadiTyped(canonicalId);
  }
  const result=await evaluateLocalFixtureUniverse(requestedId,options.policyVersion,{persistFreshness:options.freshnessRevalidate,relationIds:options.relationId?[options.relationId]:undefined,now:options.now,runId:options.runId});
  console.log(JSON.stringify({status:'EVALUATED',universeId:requestedId,executionMode:result.executionMode,dataOrigin:result.dataOrigin,results:result.results.map(item=>({relationId:item.relationId,verdict:item.decision.verdict,reasonCodes:item.decision.reasonCodes}))}));
  return result;
}
