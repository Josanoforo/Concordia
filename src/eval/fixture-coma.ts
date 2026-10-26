import { COMA_STANDIN_PROVIDER, type ComaBridge, type ComaSchemaInput } from '../discovery/coma-provider.ts';

/**
 * Offline, deterministic STAND-IN for COMA's schema matching, used only by the offline evaluation of blind universes: Jaccard of the underscore tokens of two
 * column names after the table prefix, kept at 0.5 or more. No Python, no network, no row values. It is not COMA: eval and reports must name it by COMA_STANDIN_ID.
 * Its output declares its own provider identity, which the COMA provider accepts only for a bridge flagged with `standInId`.
 */
export const COMA_STANDIN_ID: typeof COMA_STANDIN_PROVIDER = COMA_STANDIN_PROVIDER;
const tokens = (name: string) => new Set(name.split('_').slice(1));
const matchPairs: ComaBridge = (input: ComaSchemaInput) => ({ schemaVersion: 1, provider: COMA_STANDIN_ID, version: '1.1.0', matches: input.pairs.map(pair => ({ source: pair.source, target: pair.target,
  matches: input.tables[pair.source].columns.flatMap(a => input.tables[pair.target].columns.flatMap(b => {
    const x = tokens(a), y = tokens(b), shared = [...x].filter(token => y.has(token)).length, score = shared / (x.size + y.size - shared);
    return score >= 0.5 ? [{ sourceColumn: a, targetColumn: b, rawScore: score }] : [];
  })) })) });
/** COMA answers a fixture declares itself: used when the allowlisted column names share too few tokens for the name stand-in to propose anything (U3). Same stand-in identity. */
export interface ScriptedComaProposal { source: string; target: string; sourceColumn: string; targetColumn: string; rawScore: number }
export function scriptedComaBridge(proposals: readonly ScriptedComaProposal[]): ComaBridge & { standInId: string } {
  return Object.assign((input: ComaSchemaInput) => ({ schemaVersion: 1 as const, provider: COMA_STANDIN_ID, version: '1.1.0' as const, matches: input.pairs.map(pair => ({ source: pair.source, target: pair.target,
    matches: proposals.filter(item => item.source === pair.source && item.target === pair.target).map(item => ({ sourceColumn: item.sourceColumn, targetColumn: item.targetColumn, rawScore: item.rawScore })) })) }) as any, { standInId: COMA_STANDIN_ID });
}
export const nameTokenComaBridge: ComaBridge & { standInId: string } = Object.assign((input: ComaSchemaInput) => matchPairs(input), { standInId: COMA_STANDIN_ID });
