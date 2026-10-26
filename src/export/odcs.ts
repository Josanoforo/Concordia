import fs from 'node:fs';
import path from 'node:path';
import { loadModelReviewOverlay, modelReviewOf, reviewOriginsOf, MODEL_REVIEW_BASIS } from '../report/review-origin.ts';
import { normalizeArtifactsOrder, normalizeRunOrder } from '../report/order.ts';
import { humanContractOf, humanContractSentence, loadNegativeControl, summarizeNegativeControl, publicHumanContract, PUBLIC_APPROVER, HUMAN_CONTRACT_BASIS } from '../report/human-contract.ts';
import { ROOT, SafeError } from '../runtime.ts';
import { universeConfig } from '../universe-pipeline.ts';

// Export de las relaciones SOSTENIDA + REVIEWED de un run del agente a un contrato Open Data Contract Standard v3.1.0 (YAML).
// Solo lee engine-run.json, artifacts.json y la config del universo; no toca el motor ni la politica de decision.
// Cada relacion exportada es una relationship foreignKey a nivel de propiedad, con procedencia en su customProperties.

const obj = (v: unknown): any => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

export type OdcsSkipped = { relationId: string; reason: string };
export type OdcsExport = { path: string; relations: number; skipped: OdcsSkipped[] };

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LOGICAL: Record<string, string> = { string: 'string', integer: 'integer', int: 'integer', bigint: 'integer', number: 'number', double: 'number', float: 'number', decimal: 'number', boolean: 'boolean', date: 'date', timestamp: 'timestamp', time: 'time' };

/** Texto de la cita tal como esta en la config; si quedo con doble codificacion (UTF-8 leido como latin1) se repara solo cuando el resultado es limpio. */
function repairQuote(text: string): string {
  if (!/[ÂÃâ]/.test(text)) return text;
  const fixed = Buffer.from(text, 'latin1').toString('utf8');
  return fixed.includes('�') ? text : fixed;
}

/** Emisor YAML propio para el subconjunto usado: mapas y listas en bloque, escalares en JSON (cadenas siempre entre comillas dobles). */
export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  const scalar = (v: unknown) => JSON.stringify(v ?? null);
  const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    return value.map(item => {
      if (item && typeof item === 'object' && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
        const inner = toYaml(item, indent + 2);
        return `${pad}- ${inner.slice(indent + 2)}`;
      }
      return `${pad}- ${item && typeof item === 'object' ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)}\n`;
    }).join('');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return `${pad}{}\n`;
    return entries.map(([k, v]) => {
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key(k)}:\n${toYaml(v, indent + 2)}`;
      return `${pad}${key(k)}: ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}\n`;
    }).join('');
  }
  return `${pad}${scalar(value)}\n`;
}

type Endpoint = { table: string; physical: string; column: string; type: string };

function endpoint(cfg: any, ref: any): Endpoint | undefined {
  const table = str(ref?.table), column = str(ref?.column);
  if (!IDENT.test(table) || !IDENT.test(column)) return undefined;
  const spec = obj(obj(cfg.tables)[table]);
  const col = arr(spec.columns).find((c: any) => c.name === column);
  return { table, physical: str(spec.physicalTable) || table, column, type: LOGICAL[str(col?.type).toLowerCase()] ?? 'string' };
}

function boundedEvidence(probe: any, decision: any): Record<string, unknown> {
  const ev = obj(probe?.evidence), overlap = obj(ev.overlap), queries = arr(ev.queries);
  const limits = queries.map(q => Number(/LIMIT (\d+)/i.exec(str(q.sql))?.[1])).filter(Number.isFinite);
  const out: Record<string, unknown> = { reasonCodes: arr(decision.reasonCodes).map(str), sampleBounded: true };
  if (probe) {
    out.sourceRefs = [str(obj(obj(ev.relationContract).from).sourceId), str(obj(obj(ev.relationContract).to).sourceId)].filter(Boolean);
    out.probedKeys = overlap.probed ?? null; out.matchedKeys = overlap.matched ?? null;
    out.queries = queries.length; out.rowsPerQuery = queries.map(q => arr(q.rows).length); out.limitPerQuery = limits;
    out.freshness = str(obj(probe.freshness).state) || str(obj(ev.freshness).state) || null;
  }
  if (decision.reused) out.reusedFromRun = str(obj(decision.reused).fromRunId);
  return out;
}

const prop = (property: string, value: unknown) => ({ property, value });

export function exportOdcs(options: { runId: string; out?: string }, deps: { runsDir?: string } = {}): OdcsExport {
  const runId = options.runId;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId ?? '')) throw new SafeError('INVALID_RUN_ID');
  const runDir = path.join(deps.runsDir ?? path.join(ROOT, '.concordia', 'agent-runs'), runId);
  const runFile = path.join(runDir, 'engine-run.json');
  if (!fs.existsSync(runFile)) throw new SafeError('AGENT_RUN_NOT_FOUND');
  const run = normalizeRunOrder(JSON.parse(fs.readFileSync(runFile, 'utf8')));
  const artFile = path.join(runDir, 'artifacts.json');
  const artifacts = fs.existsSync(artFile) ? normalizeArtifactsOrder(JSON.parse(fs.readFileSync(artFile, 'utf8'))) : {};
  let cfg: any = {};
  try { cfg = universeConfig(str(run.universeId)); } catch (e) { throw new SafeError('ODCS_UNIVERSE_CONFIG_UNREADABLE', undefined, `la configuracion del universo ${str(run.universeId)} no se pudo leer; sin ella no se puede comprobar la autorizacion de revision`); }
  const configRelations = new Map<string, any>(arr(cfg.relations).map((r: any) => [str(r.id), r]));
  const probes = new Map<string, any>(arr(artifacts.probes).map((p: any) => [str(p.relationId), p]));

  const skipped: OdcsSkipped[] = [];
  const tables = new Map<string, { physical: string; props: Map<string, string>; rels: Map<string, any[]> }>();
  const table = (e: Endpoint) => { if (!tables.has(e.table)) tables.set(e.table, { physical: e.physical, props: new Map(), rels: new Map() }); return tables.get(e.table)!; };
  let exported = 0;

  for (const decision of arr(run.decisions)) {
    const id = str(decision.relationId);
    if (decision.verdict !== 'SOSTENIDA') { skipped.push({ relationId: id, reason: `veredicto ${str(decision.verdict) || 'desconocido'}, no SOSTENIDA (${arr(decision.reasonCodes).map(str).join(', ') || 'sin razones'})` }); continue; }
    const probe = probes.get(id), conf = configRelations.get(id);
    if (!probe) { skipped.push({ relationId: id, reason: decision.reused ? `reusada de ${str(obj(decision.reused).fromRunId) || 'otro run'}; este run no tiene sonda ni contrato congelado de la relacion` : 'sin sonda en este run: no hay contrato congelado del que tomar la revision' }); continue; }
    // La revision sale del contrato congelado en la sonda de este run, no de la configuracion vigente.
    const reviewState = str(obj(obj(probe.evidence).relationContract).reviewState) || 'UNKNOWN';
    if (reviewState !== 'REVIEWED') { skipped.push({ relationId: id, reason: `contrato congelado ${reviewState}, no REVIEWED` }); continue; }
    // La autorizacion sale de lo congelado en la sonda de este run (evidence.reviewAuthorization, o la relacion guardada en la sonda); nunca de la config vigente.
    const frozen = obj(probe.evidence).reviewAuthorization ?? obj(obj(probe.evidence).relation).reviewAuthorization, auth = obj(frozen);
    if (frozen === undefined) { skipped.push({ relationId: id, reason: 'reviewAuthorization no congelada en este run' }); continue; }
    if (!auth.approver || !auth.approvedAt || !auth.quote) { skipped.push({ relationId: id, reason: 'REVIEWED sin reviewAuthorization completa (aprobador, fecha, cita) en la sonda congelada' }); continue; }
    const ref = conf ?? obj(obj(probe?.evidence).relation);
    const from = endpoint(cfg, ref.from), to = endpoint(cfg, ref.to);
    if (!from || !to) { skipped.push({ relationId: id, reason: 'extremos de la relacion no resolubles a tabla.columna' }); continue; }

    const t = table(from); table(to);
    t.props.set(from.column, from.type); tables.get(to.table)!.props.set(to.column, to.type);
    const list = t.rels.get(from.column) ?? [];
    list.push({ type: 'foreignKey', to: `${to.table}.${to.column}`, customProperties: [
      prop('concordiaRelationId', id), prop('concordiaRunId', runId), prop('concordiaVerdict', 'SOSTENIDA'),
      prop('concordiaNormalization', str(conf?.normalization) || str(probe?.normalization) || null),
      prop('concordiaEvidence', boundedEvidence(probe, decision)),
      prop('concordiaReviewAuthorization', { approver: PUBLIC_APPROVER, approvedAt: str(auth.approvedAt), quote: repairQuote(str(auth.quote)), ...(auth.session ? { session: str(auth.session) } : {}), ...(auth.overlaySha256 ? { overlayOrigin: str(auth.overlayOrigin), overlaySha256: str(auth.overlaySha256) } : {}) }),
    ] });
    t.rels.set(from.column, list); exported++;
  }

  const schema = [...tables.entries()].map(([name, t]) => ({ name, physicalName: t.physical, physicalType: 'table', logicalType: 'object',
    properties: [...t.props.entries()].map(([column, logicalType]) => ({ name: column, logicalType, ...(t.rels.has(column) ? { relationships: t.rels.get(column) } : {}) })) }));
  const hcBase = humanContractOf(run, artifacts), ncFile = loadNegativeControl(runDir, run?.reviewOverlay?.negativeControl);
  const hcRaw = hcBase && ncFile !== undefined ? { ...hcBase, negativeControl: summarizeNegativeControl(ncFile) } : hcBase;
  const hc = hcRaw && publicHumanContract(hcRaw);
  const mrv = modelReviewOf(run, loadModelReviewOverlay(runDir)), origins = reviewOriginsOf(run, artifacts);
  const contract = {
    apiVersion: 'v3.1.0', kind: 'DataContract', id: `concordia-${runId}`, version: '1.0.0', status: 'draft',
    name: `Concordia reviewed relations ${str(run.universeId)} ${runId}`,
    description: { purpose: 'Foreign-key relationships sustained by bounded read-only evidence and approved by a human review. Not a global or table-wide claim.' + (hc ? ` ${humanContractSentence(hc)}` : '') },
    contractCreatedTs: str(run.utc) || undefined,
    customProperties: [prop('exportedBy', 'concordia'), prop('runId', runId), prop('universeId', str(run.universeId)), prop('executionMode', str(run.executionMode)), prop('dataOrigin', str(run.dataOrigin)),
      prop('relationsExported', exported), prop('relationsSkipped', skipped.length),
      ...(mrv ? [prop('concordiaModelReview', { basis: MODEL_REVIEW_BASIS, origin: 'MODEL_REVIEWED', provenance: mrv.provenance, status: mrv.status, candidates: mrv.counts.candidates ?? null, reviewed: mrv.counts.reviewed ?? mrv.reviews.length, approved: mrv.counts.approved ?? mrv.approved.length, evaluations: mrv.reviews.reduce((n, r) => n + r.evaluations.length, 0), attacks: mrv.reviews.reduce((n, r) => n + r.attacks.length, 0), tokens: mrv.tokens, reviewedByHuman: false }), prop('concordiaReviewOrigins', origins.counts)] : []),
      ...(hc ? [prop('concordiaBasis', HUMAN_CONTRACT_BASIS), prop('concordiaHumanContract', { approver: hc.approver, approvedAt: hc.approvedAt, session: hc.session, origin: hc.origin, overlaySha256: hc.sha256 }),
        prop('concordiaDeferredRelations', hc.deferred), ...(hc.negativeControl !== undefined ? [prop('concordiaNegativeControl', hc.negativeControl)] : [])] : [])],
    ...(schema.length ? { schema } : {}),
  };

  const target = options.out ? path.resolve(options.out) : path.join(runDir, 'contract.odcs.yaml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toYaml(contract));
  const rel = path.relative(ROOT, target);
  return { path: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : target, relations: exported, skipped };
}

// ---- Dossier USL: el modelo semantico publicado, con su procedencia y autorizacion, como contrato ODCS (R6-Z5). Misma salida y emisor que arriba.

const NEUTRAL_APPROVER = 'project-owner';
const COLUMN_TYPE = (type: string) => (/^(var)?char|^text|^string/i.test(type) ? 'string' : /^(big|small)?int/i.test(type) ? 'integer' : /^(decimal|numeric|double|float)/i.test(type) ? 'number' : /^bool/i.test(type) ? 'boolean' : /^timestamp/i.test(type) ? 'timestamp' : /^date/i.test(type) ? 'date' : 'string');

/** Join de la ACTIVATE planificada: "FROM <a> AS src INNER JOIN <b> AS tgt ON src.<x> = tgt.<y>". */
function activationJoin(sql: string): { fromTable: string; fromColumn: string; toTable: string; toColumn: string } | undefined {
  const m = /FROM\s+(\S+)\s+AS\s+src\s+INNER\s+JOIN\s+(\S+)\s+AS\s+tgt\s+ON\s+src\.(\w+)\s*=\s*tgt\.(\w+)/i.exec(sql);
  if (!m) return undefined;
  const last = (name: string) => name.split('.').pop()!;
  return { fromTable: last(m[1]!), toTable: last(m[2]!), fromColumn: m[3]!, toColumn: m[4]! };
}

const readJsonFile = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Exporta un plan de publicacion USL (y su run verificado y su grant) como contrato ODCS v3.1.0.
 * Entradas por ruta: `plan` (plan.json), `run` (carpeta con journal.jsonl) y `grant` (grant vivo, o un archivo con liveAuthorizationGrant).
 * Sin run verificado o sin autorizacion ligada a este plan, no se exporta y la razon queda en `skipped`. Nunca copia queryId, requestId ni attemptRef;
 * el aprobador sale neutro. `relations` cuenta el modelo publicado exportado (0 o 1).
 */
export function exportUslOdcs(options: { plan: string; run?: string; grant?: string; out?: string }): OdcsExport {
  if (!options.plan || !fs.existsSync(options.plan)) throw new SafeError('USL_PLAN_NOT_FOUND');
  const plan = readJsonFile(options.plan), planId = str(plan.publicationManifestRef) || 'plan';
  const skipped: OdcsSkipped[] = [];
  const skip = (reason: string) => skipped.push({ relationId: str(plan.relationRef) || planId, reason });

  let grant: any;
  if (options.grant && fs.existsSync(options.grant)) { const g = readJsonFile(options.grant); grant = g.liveAuthorizationGrant ?? g; }
  const ops = arr(plan.operations), sqlHashes = ops.flatMap(o => (o.sqlSha256 ? [str(o.sqlSha256)] : []));
  if (!grant || !grant.approvedAt || !grant.approvedBy) skip('sin autorizacion humana (grant) para este plan');
  else if (grant.planFingerprint !== plan.fingerprint) skip('el grant no corresponde al fingerprint de este plan');
  else if (JSON.stringify([...arr(grant.operationSqlSha256s)].sort()) !== JSON.stringify([...sqlHashes].sort())) skip('el grant no cubre exactamente los sqlSha256 de este plan');

  let events: any[] = [];
  const journal = options.run ? path.join(options.run, 'journal.jsonl') : '';
  if (journal && fs.existsSync(journal)) events = fs.readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  const verified = events.filter(e => e.state === 'verified' && e.fingerprint === plan.fingerprint).pop();
  if (!events.length) skip('sin run de publicacion (journal) para este plan');
  else if (!verified) skip('el run no esta verificado para este plan');

  const activation = ops.find(o => o.role === 'ACTIVATION'), join = activation?.sql ? activationJoin(str(activation.sql)) : undefined;
  if (!skipped.length && !join) skip('la activacion del plan no es un INNER JOIN reconocible entre dos tablas');

  const target = obj(plan.target), targetRef = `${str(target.namespace)}.${str(target.model)}`;
  const applied = events.filter(e => e.state === 'applied' && e.operationStatus === 'OK').map(e => str(e.operationId));
  const base = {
    apiVersion: 'v3.1.0', kind: 'DataContract', id: `concordia-usl-${str(plan.fingerprint).slice(0, 24) || 'plan'}`, version: '1.0.0', status: 'draft',
    name: `Concordia USL published model ${str(target.model)}`,
    description: { purpose: 'Semantic model published through a plan-bound USL publication, with the human authorization and verification that support it. Observed relation over bounded evidence; not a global or table-wide claim.' },
    contractCreatedTs: str(verified?.at) || undefined,
  };
  let contract: any;
  if (skipped.length || !join) {
    contract = { ...base, customProperties: [prop('exportedBy', 'concordia'), prop('planFingerprint', str(plan.fingerprint)), prop('relationsExported', 0), prop('relationsSkipped', skipped.length)] };
  } else {
    const sourceMap = new Map<string, any>(arr(obj(plan.sourceBinding).mappingRefs).map((r: string) => [str(r).split('.').pop()!, r]));
    const columns = arr(plan.columnDefinitions).map(c => ({ name: str(c.name), logicalType: COLUMN_TYPE(str(c.type)), physicalType: str(c.type) }));
    const model = { name: str(target.model), physicalName: targetRef, physicalType: 'table', logicalType: 'object',
      customProperties: [prop('publicationBasis', str(plan.publicationBasis)), prop('activatedTable', str(target.table)), prop('activationSqlSha256', str(activation.sqlSha256))],
      properties: columns };
    const source = (table: string, column: string, relationships?: any[]) => ({ name: table, physicalName: table, physicalType: 'table', logicalType: 'object',
      properties: [{ name: column, logicalType: 'string', ...(relationships ? { relationships } : {}) }] });
    const fk = [{ type: 'foreignKey', to: `${join.toTable}.${join.toColumn}`, customProperties: [
      prop('concordiaRelationRef', str(plan.relationRef)), prop('concordiaContractVersion', str(plan.contractVersion)), prop('concordiaDecisionRef', str(plan.decisionRef)),
      prop('concordiaPolicyVersion', str(plan.policyVersion)), prop('concordiaPublicationBasis', str(plan.publicationBasis)), prop('concordiaEvidenceRefs', arr(plan.evidenceRefs).map(str)),
      prop('concordiaSourceMappings', [sourceMap.get(join.fromTable), sourceMap.get(join.toTable)].filter(Boolean))] }];
    contract = { ...base,
      customProperties: [prop('exportedBy', 'concordia'), prop('universeId', str(plan.universeId)), prop('executionMode', str(plan.executionMode)), prop('dataOrigin', str(plan.dataOrigin)),
        prop('relationsExported', 1), prop('relationsSkipped', 0),
        prop('publication', { namespace: str(target.namespace), model: str(target.model), targetRef, relationActivated: true, planStatus: str(plan.status), rendererVersion: str(plan.rendererVersion) }),
        prop('planProvenance', { planFingerprint: str(plan.fingerprint), publicationManifestFingerprint: str(plan.publicationManifestFingerprint), inputFingerprints: obj(plan.inputFingerprints),
          operations: ops.filter(o => o.sqlSha256).map(o => ({ operationId: str(o.operationId), role: str(o.role), sqlSha256: str(o.sqlSha256) })) }),
        prop('runProvenance', { runId: str(verified.runId), events: events.length, appliedOperations: applied, contentFingerprint: str(verified.contentFingerprint), targetStateFingerprint: str(verified.targetStateFingerprint) }),
        prop('verification', { state: 'verified', verifiedAt: str(verified.at), method: 'LOAD of the exact versioned model plus a bounded read of the activated table, as planned', expectedProjection: obj(plan.expectedProjection) }),
        prop('reviewAuthorization', { approver: NEUTRAL_APPROVER, approvedAt: str(grant.approvedAt), scope: str(grant.scope), grantId: str(grant.grantId), planFingerprintBound: true, sqlHashesBound: sqlHashes.length,
          dialectId: str(grant.dialectId), expiresAt: str(grant.expiresAt) })],
      schema: [model, source(join.fromTable, join.fromColumn, fk), source(join.toTable, join.toColumn)] };
  }

  const out = options.out ? path.resolve(options.out) : path.join(path.dirname(path.resolve(options.plan)), `${str(target.model) || 'usl'}.odcs.yaml`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toYaml(contract));
  const rel = path.relative(ROOT, out);
  return { path: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : out, relations: skipped.length ? 0 : 1, skipped };
}
