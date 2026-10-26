/**
 * El orden de decisions[] y de phases.probes.selected sigue las pistas de exploracion (P6): puede cambiar entre runs sin cambiar lo decidido.
 * Reporte, exportaciones y comparadores ordenan por relationId donde dependen del orden, para que la misma decision produzca la misma salida.
 * (No toca los rankings que son dato: propuestas post-COMA, candidatas ordenadas por cobertura, etc.)
 */
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const key = (x: unknown): string => typeof x === 'string' ? x : String(obj(x).relationId ?? obj(x).relation?.id ?? '');
const byId = <T>(list: T[]): T[] => [...list].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });

export function normalizeRunOrder<T = any>(run: T): T {
  const r = obj(run);
  if (!Object.keys(r).length) return run;
  const phases = obj(r.phases), probes = obj(phases.probes);
  const out: any = { ...r };
  if (Array.isArray(r.decisions)) out.decisions = byId(r.decisions);
  if (Array.isArray(probes.selected) || Array.isArray(probes.skipped)) out.phases = { ...phases, probes: { ...probes, ...(Array.isArray(probes.selected) ? { selected: [...probes.selected].sort() } : {}), ...(Array.isArray(probes.skipped) ? { skipped: byId(probes.skipped) } : {}) } };
  const ps = obj(r.probeSelection);
  if (Array.isArray(ps.selected) || Array.isArray(ps.skipped)) out.probeSelection = { ...ps, ...(Array.isArray(ps.selected) ? { selected: [...ps.selected].sort() } : {}), ...(Array.isArray(ps.skipped) ? { skipped: byId(ps.skipped) } : {}) };
  return out as T;
}

export function normalizeArtifactsOrder<T = unknown>(artifacts: T): T {
  const a = obj(artifacts);
  return Array.isArray(a.probes) ? { ...a, probes: byId(a.probes) } as T : artifacts;
}
