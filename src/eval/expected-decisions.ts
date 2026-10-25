export interface ExpectedDecisionConfig {
  expected?: string[];
  expectedByContractVersion?: Record<string, string[]>;
  expectedProvenanceByContractVersion?: Record<string, { reasonCodes: string[]; explanation: string }>;
}

export interface ExpectedDecisionSelection {
  expected: string[];
  contractVersion: string | null;
  source: 'CONTRACT_VERSION' | 'LEGACY' | 'UNCONFIGURED_CONTRACT_VERSION';
  provenance: { reasonCodes: string[]; explanation: string } | null;
}

/** Contract-scoped expectations are policy regression checks, not adjudicated truth labels. */
export function selectExpectedDecision(config: ExpectedDecisionConfig, evidenceContractVersion: string | null | undefined): ExpectedDecisionSelection {
  const version = typeof evidenceContractVersion === 'string' ? evidenceContractVersion : null;
  if (config.expectedByContractVersion) {
    const expected = version ? config.expectedByContractVersion[version] : undefined;
    if (expected) return {
      expected: [...expected], contractVersion: version, source: 'CONTRACT_VERSION',
      provenance: version ? config.expectedProvenanceByContractVersion?.[version] ?? null : null
    };
    return { expected: [], contractVersion: version, source: 'UNCONFIGURED_CONTRACT_VERSION', provenance: null };
  }
  return { expected: [...(config.expected ?? [])], contractVersion: version, source: 'LEGACY', provenance: null };
}

/** A semantic expectation passes only when its required evaluator causes are present. */
export function expectedDecisionMatches(selection: ExpectedDecisionSelection, actual: string, actualReasonCodes: readonly string[]): { pass: boolean; reasonCodesMet: boolean } {
  const required = selection.provenance?.reasonCodes ?? [];
  const reasonCodesMet = required.every(code => actualReasonCodes.includes(code));
  return { pass: selection.expected.includes(actual) && reasonCodesMet, reasonCodesMet };
}
