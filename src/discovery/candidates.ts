import { createHash } from 'node:crypto';
import type { Candidate, RelationContract, Unknown } from '../contracts/types.ts';

export type DiscoveryExecutionMode = 'LIVE' | 'REPLAY' | 'LOCAL';
export type DiscoveryDataOrigin = 'SYNTHETIC' | 'PUBLIC' | 'USER' | 'UNKNOWN';
export interface CandidateProviderDescriptor {
  providerId: string;
  version: string;
  method: string;
  universeId: string;
  sourceId: string;
  sourceVersion: Unknown<string>;
  configFingerprint: string;
  inputHash: string;
  scope: { tables: string[]; columns: string[] };
  capability: 'SUPPORTED' | 'UNSUPPORTED';
  enabled: boolean;
  executionMode: DiscoveryExecutionMode;
  dataOrigin: DiscoveryDataOrigin;
}
export interface CandidateProviderContext {
  descriptor: CandidateProviderDescriptor;
  tableMetadata: Readonly<Record<string, { columns: readonly { name: string; type: string }[]; keyColumns: readonly string[]; role: string }>>;
  evidenceRefs: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
}
export interface LegacyCandidateContribution {
  id: string;
  from: { db: string; table: string; column: string };
  to: { db: string; table: string; column: string };
  reason: string[];
  proposedBy: 'heuristic' | 'llm';
  proposedBySources?: string[];
  llmReceiptId?: string;
  confidence: number;
}
export interface CandidateContribution {
  candidate: Candidate;
  methodId?: string;
  methodIds?: string[];
  reasons: string[];
  evidenceRefs: string[];
  diagnostics?: Record<string, unknown>[];
  legacyCandidate?: LegacyCandidateContribution;
}
export interface CandidateProviderOutcome {
  contributions: CandidateContribution[];
  /** Diagnostic proposals deliberately held outside configured scope; never evaluated as relations. */
  outOfScopeProposals?: OutOfScopeProposal[];
  abstentions: { reason: string; scope?: string }[];
  errors: { code: string; scope?: string; partial: boolean }[];
  partial: boolean;
  limitations: string[];
}
export interface OutOfScopeProposal {
  providerId: string;
  providerVersion: string;
  method: string;
  from: { db: string; table: string; column: string };
  to: { db: string; table: string; column: string };
  rawScore: number;
  reason: string;
  verificationStatus: 'NO VERIFICADO/UNKNOWN';
  reviewState: 'PENDING';
  inputHash: string;
  configHash: string;
  evidenceRefs: string[];
}
export interface CandidateProvider {
  descriptor: Omit<CandidateProviderDescriptor, 'universeId' | 'sourceId' | 'sourceVersion' | 'configFingerprint' | 'inputHash' | 'scope' | 'enabled' | 'executionMode' | 'dataOrigin'>;
  produce(context: CandidateProviderContext): CandidateProviderOutcome | Promise<CandidateProviderOutcome>;
}
export interface CandidateProductionEnvelope {
  schemaVersion: 1;
  executionMode: DiscoveryExecutionMode;
  dataOrigin: DiscoveryDataOrigin;
  inputHash: string;
  status: 'COMPLETE' | 'PARTIAL' | 'ABSTAINED' | 'ERROR';
  providers: CandidateProviderDescriptor[];
  providerStates: { providerId: string; status: 'COMPLETE' | 'PARTIAL' | 'ABSTAINED' | 'ERROR' | 'DISABLED' }[];
  candidates: Candidate[];
  contributions: CandidateContribution[];
  /** Optional for provider compatibility; not part of candidates or reviewQueue. */
  outOfScopeProposals?: OutOfScopeProposal[];
  legacyCandidates: LegacyCandidateContribution[];
  abstentions: { providerId: string; reason: string; scope?: string }[];
  errors: { providerId: string; code: string; scope?: string; partial: boolean }[];
  limitations: string[];
  reviewQueue: { candidateId: string; state: 'PENDING' }[];
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
export const fingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

function withoutUnknownProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnknownProvenance);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const isUnknown = ['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'].includes(String(record.state));
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !(isUnknown && key === 'provenance'))
    .map(([key, item]) => [key, withoutUnknownProvenance(item)]));
}

function mergedProvenance(values: readonly unknown[]): unknown {
  const unique = [...new Map(values.map(value => [canonical(value), value])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
  if (unique.length <= 1) return unique[0];
  return JSON.stringify(unique);
}

function mergePreservingUnknownProvenance(values: readonly unknown[]): unknown {
  const first = values[0];
  if (values.length < 2 || values.every(value => canonical(value) === canonical(first))) return structuredClone(first);
  if (Array.isArray(first) && values.every(Array.isArray) && values.every(value => value.length === first.length)) {
    return first.map((_item, index) => mergePreservingUnknownProvenance(values.map(value => (value as unknown[])[index])));
  }
  if (first && typeof first === 'object' && values.every(value => value && typeof value === 'object' && !Array.isArray(value))) {
    const records = values as Record<string, unknown>[];
    const output: Record<string, unknown> = structuredClone(records[0]);
    const keys = new Set(records.flatMap(record => Object.keys(record)));
    for (const key of keys) {
      const present = records.filter(record => Object.hasOwn(record, key)).map(record => record[key]);
      const stateful = records.every(record => ['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'].includes(String(record.state)));
      if (key === 'provenance' && stateful) output[key] = mergedProvenance(present);
      else if (present.length === records.length) output[key] = mergePreservingUnknownProvenance(present);
    }
    return output;
  }
  return structuredClone(first);
}

function reviewStateForMerge(states: readonly RelationContract['reviewState'][]): RelationContract['reviewState'] {
  if (states.includes('UNKNOWN')) return 'UNKNOWN';
  if (states.includes('PENDING')) return 'PENDING';
  return 'REVIEWED';
}

/** Identity is structural and typed. Ordered endpoint and normalization component arrays stay ordered. */
export function candidateIdentity(candidate: Candidate): string {
  const c = candidate.relationDraft;
  const assertionMeaning = new Map(c.assertions.map(assertion => {
    const meaning = { claim: withoutUnknownProvenance(assertion.claim), scope: withoutUnknownProvenance(assertion.scope) };
    return [canonical(meaning), meaning] as const;
  }));
  const semanticContract = {
    contractVersion: c.contractVersion,
    universeRef: withoutUnknownProvenance(c.universeRef),
    from: withoutUnknownProvenance(c.from),
    to: withoutUnknownProvenance(c.to),
    kind: c.kind,
    identifierSpace: withoutUnknownProvenance(c.identifierSpace),
    normalization: withoutUnknownProvenance(c.normalization),
    semanticContext: withoutUnknownProvenance(c.semanticContext),
    assertions: [...assertionMeaning.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, assertion]) => assertion),
    evidencePolicy: withoutUnknownProvenance(c.evidencePolicy)
  };
  return `sem:${fingerprint(semanticContract)}`;
}

const statusRank: Record<Candidate['status'], number> = { PROPOSED: 0, DUPLICATE: 1, UNKNOWN: 2, INCOMPLETE: 3, CONFLICTED: 4 };
const stableUnique = (items: readonly string[]) => [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
const orderedUnique = (items: readonly string[]) => [...new Set(items.filter(Boolean))];

/** Deduplicates contributions, never confidence-votes or upgrades shared Candidate.status. */
export function deduplicateContributions(contributions: readonly CandidateContribution[]): { candidates: Candidate[]; contributions: CandidateContribution[]; legacyCandidates: LegacyCandidateContribution[] } {
  const ordered = [...contributions].sort((a, b) => candidateIdentity(a.candidate).localeCompare(candidateIdentity(b.candidate), 'en')
    || canonical(a).localeCompare(canonical(b), 'en'));
  const groups = new Map<string, CandidateContribution[]>();
  for (const item of ordered) {
    const key = candidateIdentity(item.candidate);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const merged: CandidateContribution[] = [], legacyByIdentity = new Map<string, LegacyCandidateContribution>();
  for (const [identity, group] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const orderedGroup = [...group].sort((a, b) => (a.methodId ?? '').localeCompare(b.methodId ?? '', 'en') || canonical(a).localeCompare(canonical(b), 'en'));
    const base = orderedGroup[0].candidate;
    const mostCautious = orderedGroup.map(item => item.candidate.status).sort((a, b) => statusRank[b] - statusRank[a])[0];
    const reasons = orderedUnique(orderedGroup.flatMap(item => item.reasons));
    const evidenceRefs = stableUnique(orderedGroup.flatMap(item => item.evidenceRefs));
    const diagnostics = [...new Map(orderedGroup.flatMap(item => item.diagnostics ?? []).map(item => [canonical(item), item])).entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, item]) => structuredClone(item));
    const provenance = stableUnique(orderedGroup.flatMap(item => item.candidate.provenance));
    const relationDraft = mergePreservingUnknownProvenance(orderedGroup.map(item => item.candidate.relationDraft)) as RelationContract;
    const assertions = new Map(orderedGroup.flatMap(item => item.candidate.relationDraft.assertions).map(assertion => [canonical(assertion), assertion] as const));
    relationDraft.assertions = [...assertions.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, assertion]) => structuredClone(assertion));
    relationDraft.reviewState = reviewStateForMerge(orderedGroup.map(item => item.candidate.relationDraft.reviewState));
    const candidate: Candidate = { ...base, candidateId: identity, relationDraft, proposedBy: 'candidate-provider', provenance, createdAt: { state: 'UNKNOWN' }, status: mostCautious };
    const methodIds = stableUnique(orderedGroup.flatMap(item => [...(item.methodIds ?? []), ...(item.methodId ? [item.methodId] : [])]));
    merged.push({ candidate, ...(methodIds.length ? { methodIds } : {}), reasons, evidenceRefs, ...(diagnostics.length ? { diagnostics } : {}), ...(orderedGroup.some(item => item.legacyCandidate) ? { legacyCandidate: { ...orderedGroup.find(item => item.legacyCandidate)!.legacyCandidate! } } : {}) });
    const legacy = orderedGroup.flatMap(item => item.legacyCandidate ? [item.legacyCandidate] : []);
    if (legacy.length) {
      const first = legacy[0];
      const sameDirection = legacy.every(item => canonical([item.from, item.to]) === canonical([first.from, first.to]));
      const from = sameDirection ? first.from : first.to;
      const to = sameDirection ? first.to : first.from;
      const reason = orderedUnique(orderedGroup.flatMap(item => item.legacyCandidate?.reason ?? []));
      const hasDeclaredSources = legacy.some(item => item.proposedBySources !== undefined);
      const sources = stableUnique(legacy.flatMap(item => item.proposedBySources ?? [item.proposedBy]));
      const confidence = Math.min(...legacy.map(item => item.confidence));
      const mergedLegacy: LegacyCandidateContribution = { ...first, from, to, reason, proposedBy: sources.length === 1 && sources[0] === 'llm' ? 'llm' : 'heuristic', proposedBySources: sources, confidence,
        ...(legacy.find(item => item.llmReceiptId)?.llmReceiptId ? { llmReceiptId: legacy.find(item => item.llmReceiptId)!.llmReceiptId } : {}) };
      if (!hasDeclaredSources) delete mergedLegacy.proposedBySources;
      legacyByIdentity.set(identity, mergedLegacy);
    }
  }
  for (const item of merged) {
    const legacyCandidate = legacyByIdentity.get(candidateIdentity(item.candidate));
    if (legacyCandidate) item.legacyCandidate = legacyCandidate;
  }
  return { candidates: merged.map(item => item.candidate), contributions: merged, legacyCandidates: [...legacyByIdentity.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, item]) => item) };
}

export async function produceCandidates(input: {
  universeId: string; sourceId: string; sourceVersion?: Unknown<string>; configFingerprint: string; inputHash: string;
  scope: { tables: string[]; columns: string[] }; executionMode: DiscoveryExecutionMode; dataOrigin: DiscoveryDataOrigin;
  tableMetadata: CandidateProviderContext['tableMetadata']; evidenceRefs?: string[]; metadata?: Record<string, unknown>;
}, providers: readonly CandidateProvider[], enabledProviderIds?: readonly string[]): Promise<CandidateProductionEnvelope> {
  if (!input.universeId || !input.sourceId || !input.configFingerprint || !input.inputHash || !Array.isArray(input.scope.tables) || !Array.isArray(input.scope.columns)) throw new TypeError('CANDIDATE_PRODUCTION_CONTEXT_INVALID');
  if (!providers.length || new Set(providers.map(provider => provider.descriptor.providerId)).size !== providers.length) throw new TypeError('CANDIDATE_PROVIDERS_INVALID');
  const enabled = new Set(enabledProviderIds ?? providers.map(provider => provider.descriptor.providerId));
  if ([...enabled].some(id => !providers.some(provider => provider.descriptor.providerId === id))) throw new TypeError('CANDIDATE_PROVIDER_NOT_REGISTERED');
  const selected = providers;
  const contributions: CandidateContribution[] = [], outOfScopeProposals: OutOfScopeProposal[] = [], descriptors: CandidateProviderDescriptor[] = [], providerStates: CandidateProductionEnvelope['providerStates'] = [], abstentions: CandidateProductionEnvelope['abstentions'] = [], errors: CandidateProductionEnvelope['errors'] = [], limitations: string[] = [];
  for (const provider of selected) {
    const descriptor: CandidateProviderDescriptor = { ...provider.descriptor, universeId: input.universeId, sourceId: input.sourceId, sourceVersion: input.sourceVersion ?? { state: 'UNKNOWN' }, configFingerprint: input.configFingerprint, inputHash: input.inputHash,
      scope: { tables: stableUnique(input.scope.tables), columns: stableUnique(input.scope.columns) }, enabled: enabled.has(provider.descriptor.providerId), executionMode: input.executionMode, dataOrigin: input.dataOrigin };
    descriptors.push(descriptor);
    if (!descriptor.enabled) { providerStates.push({ providerId: descriptor.providerId, status: 'DISABLED' }); continue; }
    if (provider.descriptor.capability === 'UNSUPPORTED') {
      abstentions.push({ providerId: descriptor.providerId, reason: 'CAPABILITY_UNSUPPORTED' });
      limitations.push(`${descriptor.providerId}: capability unsupported for this adapter`);
      providerStates.push({ providerId: descriptor.providerId, status: 'ABSTAINED' });
      continue;
    }
    if (!provider.descriptor.providerId || !provider.descriptor.version || !provider.descriptor.method) {
      errors.push({ providerId: provider.descriptor.providerId || 'UNKNOWN', code: 'CANDIDATE_PROVIDER_METADATA_INVALID', partial: true });
      providerStates.push({ providerId: provider.descriptor.providerId || 'UNKNOWN', status: 'ERROR' }); continue;
    }
    const contributionStart = contributions.length;
    try {
      const output = await provider.produce({ descriptor, tableMetadata: input.tableMetadata, evidenceRefs: stableUnique(input.evidenceRefs ?? []), metadata: input.metadata ?? {} });
      for (const item of output.contributions) {
        if (!item.candidate?.relationDraft || !item.candidate.candidateId || !Array.isArray(item.reasons) || !Array.isArray(item.evidenceRefs)) throw new TypeError('CANDIDATE_PROVIDER_OUTPUT_INVALID');
        const method = item.methodIds?.join('+') || item.methodId || descriptor.method;
        contributions.push({ ...item, candidate: { ...item.candidate, provenance: stableUnique([...item.candidate.provenance, `${descriptor.providerId}@${descriptor.version}:${method}`]) } });
      }
      abstentions.push(...output.abstentions.map(item => ({ providerId: descriptor.providerId, ...item })));
      outOfScopeProposals.push(...(output.outOfScopeProposals ?? []));
      errors.push(...output.errors.map(item => ({ providerId: descriptor.providerId, ...item })));
      limitations.push(...output.limitations);
      if (output.partial) errors.push({ providerId: descriptor.providerId, code: 'PROVIDER_PARTIAL', partial: true });
      providerStates.push({ providerId: descriptor.providerId, status: output.errors.length ? output.contributions.length ? 'PARTIAL' : 'ERROR' : output.partial ? 'PARTIAL' : output.contributions.length ? 'COMPLETE' : 'ABSTAINED' });
    } catch (error) {
      const partial = contributions.length > contributionStart;
      errors.push({ providerId: descriptor.providerId, code: error instanceof Error ? error.name : 'CANDIDATE_PROVIDER_ERROR', partial });
      providerStates.push({ providerId: descriptor.providerId, status: partial ? 'PARTIAL' : 'ERROR' });
    }
  }
  const deduped = deduplicateContributions(contributions);
  const status = errors.length ? deduped.candidates.length ? 'PARTIAL' : 'ERROR' : deduped.candidates.length ? 'COMPLETE' : 'ABSTAINED';
  return { schemaVersion: 1, executionMode: input.executionMode, dataOrigin: input.dataOrigin, inputHash: input.inputHash, status, providers: descriptors.sort((a, b) => a.providerId.localeCompare(b.providerId, 'en')), providerStates: providerStates.sort((a, b) => a.providerId.localeCompare(b.providerId, 'en')), ...deduped, ...(outOfScopeProposals.length ? { outOfScopeProposals } : {}), abstentions: abstentions.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en')),
    errors: errors.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en')), limitations: stableUnique(limitations), reviewQueue: deduped.candidates.map(candidate => ({ candidateId: candidate.candidateId, state: 'PENDING' as const })) };
}

export function withUniverseContext(contract: RelationContract, universe: { id: string; version?: Unknown<string>; namespace?: Unknown<string>; configFingerprint: string }): RelationContract {
  const unknown = <T,>(): Unknown<T> => ({ state: 'UNKNOWN' });
  return { ...contract, universeRef: { universeId: universe.id, universeVersion: universe.version ?? unknown<string>(), namespace: universe.namespace ?? unknown<string>(), configFingerprint: { state: 'KNOWN', value: universe.configFingerprint } } };
}
