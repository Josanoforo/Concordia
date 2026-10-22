import { HMEM } from './hmem/index.ts';
import { readJson, SafeError, writeJson } from './runtime.ts';
export function hmemSmoke() {
  const r = readJson('out/U1/relaciones.json').relations.find((r: any) => r.verdict === 'SOSTENIDA');
  if (!r) throw new SafeError('NO_SUSTAINED_RELATION_FOR_HMEM_SMOKE');
  const hmem = new HMEM({ actor: 'concordia-d1-smoke' });
  const content = `Concordia U1: NY_TAXI ${r.relationId} supported by bounded SQL key probes; identity is not globally proven.`;
  const memory = hmem.add({ content, type: 'factual', layer: 'working', source: 'NY_TAXI bounded SQL probes', confidence: 0.9,
    tags: ['project:concordia','U1'], provenance: { origin: 'document', learnedAt: Date.now(), label: 'D1 relation evidence', refs: r.evidence.queries.map((q: any) => q.requestId) } });
  const result = hmem.query(content);
  if (!result.memories.some(m => m.memory.id === memory.id)) throw new SafeError('HMEM_QUERY_DID_NOT_RETRIEVE_ADDED_MEMORY');
  const evidence = { utc: new Date().toISOString(), status: 'PASS', memoryId: memory.id, source: memory.source, provenance: memory.provenance, queryCount: result.memories.length, trace: result.trace };
  writeJson('out/U1/hmem-smoke.json', evidence); console.log('PASS H-MEM add/query', memory.id);
  return evidence;
}
