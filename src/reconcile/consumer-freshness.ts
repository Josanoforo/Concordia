import { readFreshnessHistory } from './freshness-history.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
import { loadSvp1Profiles } from '../svp1.ts';
import { resolveFreshnessRelationId } from './freshness-scope.ts';

export type ConsumerFreshnessState = 'CURRENT' | 'STALE' | 'PENDING' | 'UNKNOWN';
export interface ConsumerFreshnessDependency {
  relationId: string;
  state: ConsumerFreshnessState;
  semanticSourceVersion: string | null;
  contractVersion: string | null;
  decisionRef: string | null;
  policyVersion: string | null;
  verdict: string | null;
  evidenceRefs: string[];
  attemptRef: string | null;
  latestCompleteAttemptRef: string | null;
  checkedAt: string | null;
}
export interface ConsumerFreshnessSnapshot {
  schemaVersion: 1;
  universeId: string;
  state: ConsumerFreshnessState;
  dependencies: ConsumerFreshnessDependency[];
}
export interface ConsumerFreshnessOptions { now?: () => number; maxAgeMs?: number; mode?: 'RENDER' | 'REGENERATE'; }
export const DEFAULT_CONSUMER_FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;
const precedence: Record<ConsumerFreshnessState, number> = { CURRENT: 0, UNKNOWN: 1, STALE: 2, PENDING: 3 };

/** Resolve product aliases before history lookup. Unknown synthetic scopes remain isolated and unchanged. */
function canonicalScope(universeInput: string) {
  const manifest = resolveUniverseManifest(universeInput);
  if (!manifest) return { universeId: universeInput, relationId: (id: string) => id };
  let profile: ReturnType<typeof loadSvp1Profiles>[number] | undefined;
  if (manifest.source.adapterId === 'local-snapshot' || manifest.source.adapterId === 'zetaris-json2-live') {
    profile = loadSvp1Profiles().find(item => item.manifestId === (manifest.source.profileManifestId ?? manifest.manifestId));
  }
  return { universeId: manifest.manifestId, relationId: (id: string) => resolveFreshnessRelationId(profile, id) };
}

/** Reads append-only history; RENDER compares stored refs, REGENERATE records the latest coherent refs. */
export function consumerFreshnessSnapshot(universeInput: string, relationIds: readonly string[], previous?: ConsumerFreshnessSnapshot, options: ConsumerFreshnessOptions = {}): ConsumerFreshnessSnapshot {
  const scope = canonicalScope(universeInput), universeId = scope.universeId;
  const canonicalRelationId = scope.relationId;
  const normalizePrevious = (item: ConsumerFreshnessDependency) => ({ ...item, relationId: canonicalRelationId(item.relationId) });
  const prior = options.mode === 'REGENERATE' ? new Map<string, ConsumerFreshnessDependency>() : new Map((previous?.schemaVersion === 1 && (previous.universeId === universeId || previous.universeId === universeInput) ? previous.dependencies.map(normalizePrevious) : []).map(item => [item.relationId, item]));
  const now = options.now?.() ?? Date.now(), maxAgeMs = options.maxAgeMs ?? DEFAULT_CONSUMER_FRESHNESS_TTL_MS;
  const canonicalIds = [...new Set(relationIds.map(canonicalRelationId))].sort((a, b) => a.localeCompare(b, 'en'));
  const dependencies = canonicalIds.map(relationId => {
    const latest = readFreshnessHistory(universeId, relationId).at(-1);
    if (!latest) return { relationId, state: 'UNKNOWN' as const, semanticSourceVersion: null, contractVersion: null, decisionRef: null, policyVersion: null, verdict: null, evidenceRefs: [], attemptRef: null, latestCompleteAttemptRef: null, checkedAt: null };
    const isIncomplete = latest.kind === 'PREFLIGHT_FAILURE' || latest.validity.completeness !== 'COMPLETE';
    const expired = maxAgeMs >= 0 && now - Date.parse(latest.validity.checkedAt) > maxAgeMs;
    const priorVersion = prior.get(relationId)?.semanticSourceVersion;
    const changedSinceConsumer = priorVersion !== undefined && priorVersion !== null && priorVersion !== latest.semanticSourceVersion;
    const needsReview = latest.comparison === 'CHANGED_REQUIRES_REVIEW' || latest.validity.state === 'STALE';
    const state: ConsumerFreshnessState = isIncomplete || expired ? 'PENDING'
      : changedSinceConsumer || options.mode !== 'REGENERATE' && needsReview && priorVersion !== latest.semanticSourceVersion ? 'STALE'
        : latest.validity.state === 'UNKNOWN' ? 'UNKNOWN' : 'CURRENT';
    return { relationId, state, semanticSourceVersion: latest.semanticSourceVersion, contractVersion: latest.contract.contractVersion, decisionRef: latest.decision?.decisionId ?? null, policyVersion: latest.decision?.policyVersion ?? latest.policy.policyVersion ?? null, verdict: latest.decision?.verdict ?? null, evidenceRefs: [...(latest.decision?.evidenceBundleRefs ?? [])].sort((a,b)=>a.localeCompare(b,'en')), attemptRef: latest.attemptId, latestCompleteAttemptRef: latest.latestCompleteAttemptRef, checkedAt: latest.validity.checkedAt };
  });
  const state = dependencies.reduce<ConsumerFreshnessState>((selected, dependency) => precedence[dependency.state] > precedence[selected] ? dependency.state : selected, 'CURRENT');
  return { schemaVersion: 1, universeId, state: dependencies.length ? state : 'UNKNOWN', dependencies };
}
export interface ConsumerInputVersion { relationId: string; verdict?: string; contractVersion?: string; decisionRef?: string; policyVersion?: string; evidenceRefs?: readonly string[]; }
/** Keeps an output stale when its own saved inputs disagree with the latest persisted dependency refs. */
export function assessConsumerInputVersions(snapshot: ConsumerFreshnessSnapshot, inputs: readonly ConsumerInputVersion[]): ConsumerFreshnessSnapshot {
  const byId=new Map(snapshot.dependencies.map(item=>[item.relationId,item]));
  const dependencies=snapshot.dependencies.map(item=>{
    const input=inputs.find(candidate=>candidate.relationId===item.relationId);if(!input)return item;
    const mismatches:string[]=[];
    for(const key of ['verdict','contractVersion','decisionRef','policyVersion'] as const)if(input[key]!==undefined&&input[key]!==item[key])mismatches.push(key);
    if(input.evidenceRefs!==undefined&&JSON.stringify([...input.evidenceRefs].sort())!==JSON.stringify([...item.evidenceRefs].sort()))mismatches.push('evidenceRefs');
    if(!mismatches.length||item.state==='PENDING'||item.state==='UNKNOWN')return item;
    return {...item,state:'STALE' as const};
  });
  const state=dependencies.reduce<ConsumerFreshnessState>((selected,item)=>precedence[item.state]>precedence[selected]?item.state:selected,'CURRENT');
  return {...snapshot,state:dependencies.length?state:'UNKNOWN',dependencies};
}