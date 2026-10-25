import { assessEvidenceValidity, invalidateDependencies, type DependencyRef, type EvidenceValidity } from './freshness.ts';

export type FreshnessCondition = 'COLD' | 'HOT_UNCHANGED' | 'HOT_ALTERED';
export type VersionAlteration = Partial<Pick<EvidenceValidity, 'sourceToken' | 'sourceFingerprint' | 'schemaFingerprint' | 'contractFingerprint' | 'normalizationFingerprint'>>;
export interface FreshnessMeasureRelation {
  relationId: string;
  /** Queries one complete probe of this relation costs. */
  reads: number;
  /** Validity recorded by the cold run; must be COMPLETE to be reusable. */
  baseline: EvidenceValidity;
  /** What changes in the altered condition (the version the source, schema, contract or normalization now reports). */
  alteration: VersionAlteration;
  /** Claims, evidence, decisions and outputs that depend on this relation's evidence (ids may include the relation id itself). */
  dependencies?: readonly DependencyRef[];
}
export interface FreshnessConditionMeasure {
  condition: FreshnessCondition; relations: number; probesExecuted: number; probesSaved: number; queriesExecuted: number; queriesSaved: number;
  evidenceReused: number; evidenceInvalidated: number; reprobed: string[]; reused: string[];
}
export interface FreshnessMeasurement {
  policy: { ttlMs: number | null; reuseRule: string; invalidationRule: string };
  conditions: Record<FreshnessCondition, FreshnessConditionMeasure>;
  /** Relations whose alteration did not change any version field, so the altered condition could not be told apart from the unchanged one. */
  undetectedAlterations: string[];
  limitations: string[];
}

const empty = (condition: FreshnessCondition, relations: number): FreshnessConditionMeasure => ({ condition, relations, probesExecuted: 0, probesSaved: 0, queriesExecuted: 0, queriesSaved: 0, evidenceReused: 0, evidenceInvalidated: 0, reprobed: [], reused: [] });
const VERSION_FIELDS = ['sourceToken', 'sourceFingerprint', 'schemaFingerprint', 'contractFingerprint', 'normalizationFingerprint'] as const;

/**
 * Measures what reusing recorded evidence saves under the three freshness conditions: cold (no history, every probe runs),
 * hot with nothing changed (a complete, unexpired baseline is reused and its probes are saved) and hot with an altered
 * version (the baseline cannot be reused; the dependents of the relation's evidence are invalidated). Pure arithmetic over
 * recorded validity records: no reads, no clock besides `now`, and it never produces or changes a verdict.
 */
export function measureFreshnessConditions(relations: readonly FreshnessMeasureRelation[], options: { ttlMs?: number; now?: number } = {}): FreshnessMeasurement {
  const now = options.now ?? Date.now(), ttlMs = options.ttlMs;
  const conditions: FreshnessMeasurement['conditions'] = { COLD: empty('COLD', relations.length), HOT_UNCHANGED: empty('HOT_UNCHANGED', relations.length), HOT_ALTERED: empty('HOT_ALTERED', relations.length) };
  const undetectedAlterations: string[] = [];
  const reprobe = (measure: FreshnessConditionMeasure, relation: FreshnessMeasureRelation) => { measure.probesExecuted++; measure.queriesExecuted += relation.reads; measure.reprobed.push(relation.relationId); };
  const reuse = (measure: FreshnessConditionMeasure, relation: FreshnessMeasureRelation) => { measure.probesSaved++; measure.queriesSaved += relation.reads; measure.evidenceReused++; measure.reused.push(relation.relationId); };
  for (const relation of relations) {
    reprobe(conditions.COLD, relation);
    const unchanged = assessEvidenceValidity(relation.baseline, relation.baseline, ttlMs, now);
    const reusable = relation.baseline.completeness === 'COMPLETE' && unchanged.state === 'CURRENT_FOR_CHECK' && !unchanged.requiresReview;
    if (reusable) reuse(conditions.HOT_UNCHANGED, relation); else reprobe(conditions.HOT_UNCHANGED, relation);
    const altered = { ...relation.baseline, ...relation.alteration };
    const detected = VERSION_FIELDS.some(field => altered[field] !== relation.baseline[field]);
    if (!detected) undetectedAlterations.push(relation.relationId);
    if (!detected && reusable) reuse(conditions.HOT_ALTERED, relation);
    else {
      reprobe(conditions.HOT_ALTERED, relation);
      if (detected) conditions.HOT_ALTERED.evidenceInvalidated += invalidateDependencies(relation.dependencies ?? [], [relation.relationId]).filter(ref => ref.state === 'STALE').length;
    }
  }
  return {
    policy: { ttlMs: ttlMs ?? null, reuseRule: 'reuse only when the baseline is COMPLETE, unexpired and the source version is unchanged', invalidationRule: 'a changed source, schema, contract or normalization version stales every dependent of the relation' },
    conditions, undetectedAlterations,
    limitations: ['The measurement is arithmetic over recorded validity records; it does not read the source, so it cannot observe real drift.',
      'Saved queries assume the relation is not re-read while its baseline stays valid; a fresh check of the source version is not charged.'] };
}
