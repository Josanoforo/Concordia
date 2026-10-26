/**
 * Name heuristics shared by the stand-in models and by the review priority order (E5-08). Pure functions of two identifiers: nothing here decides a relation,
 * it only orders work and lets the offline stand-ins read names the way a reviewer would.
 */
const SUFFIXES = new Set(['sk', 'id', 'key', 'number', 'no', 'num', 'code']);
export const tokensOf = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Entity a column name refers to: table prefix and key suffix stripped ("ss_store_sk" -> ["store"], "cp_end_date_sk" -> ["end", "date"]). */
export function sourceEntity(column: string): string[] {
  let tokens = tokensOf(column);
  if (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1);
  if (tokens.length > 1 && tokens[0]!.length <= 3) tokens = tokens.slice(1);
  return tokens;
}

/** Does an entity (head noun = last token) name the table? Prefix tolerance covers "promo" / "promotion". */
export function entityNamesTable(entity: readonly string[], table: string): boolean {
  const head = entity[entity.length - 1];
  if (!head) return false;
  return tokensOf(table).some(token => token === head || (head.length >= 4 && token.startsWith(head)) || (token.length >= 4 && head.startsWith(token)));
}

/** 1 when the source column names the entity of the target table, else 0. */
export const nameAffinity = (sourceColumn: string, targetTable: string): 0 | 1 => (entityNamesTable(sourceEntity(sourceColumn), targetTable) ? 1 : 0);
