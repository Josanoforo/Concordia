// Validador minimo de JSON Schema (draft 2019-09, subconjunto usado por el schema oficial de ODCS v3.1.0). Sin dependencias.
type Res = { errors: string[]; evaluated: Set<string> };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function validateAgainst(schema: any, data: unknown): string[] {
  const root = schema;
  const resolve = (ref: string) => ref.replace(/^#\//, '').split('/').reduce((n: any, k) => n[k], root);
  const run = (s: any, d: unknown, at: string): Res => {
    if (s === true || s === undefined) return { errors: [], evaluated: new Set() };
    if (s === false) return { errors: [`${at}: schema false`], evaluated: new Set() };
    const errors: string[] = [], evaluated = new Set<string>();
    const merge = (r: Res) => { errors.push(...r.errors); r.evaluated.forEach(k => evaluated.add(k)); };
    if (s.$ref) merge(run(resolve(s.$ref), d, at));
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const actual = d === null ? 'null' : Array.isArray(d) ? 'array' : Number.isInteger(d) ? 'integer' : typeof d;
      if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) errors.push(`${at}: expected ${types.join('|')}, got ${actual}`);
    }
    if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(d))) errors.push(`${at}: not in enum`);
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(d)) errors.push(`${at}: const`);
    if (typeof d === 'string' && s.pattern && !new RegExp(s.pattern).test(d)) errors.push(`${at}: pattern ${s.pattern}`);
    if (Array.isArray(d)) {
      if (s.minItems !== undefined && d.length < s.minItems) errors.push(`${at}: minItems`);
      if (s.items) d.forEach((item, i) => merge(run(s.items, item, `${at}/${i}`)));
    }
    if (isObj(d)) {
      for (const k of s.required ?? []) if (!(k in d)) errors.push(`${at}: missing ${k}`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in d) { evaluated.add(k); merge(run(sub, d[k], `${at}/${k}`)); }
      if (s.additionalProperties !== undefined) for (const k of Object.keys(d)) if (!(s.properties && k in s.properties)) {
        evaluated.add(k); if (s.additionalProperties === false) errors.push(`${at}: additional ${k}`); else merge(run(s.additionalProperties, d[k], `${at}/${k}`));
      }
    }
    for (const sub of s.allOf ?? []) merge(run(sub, d, at));
    for (const key of ['anyOf', 'oneOf'] as const) if (s[key]) {
      const rs = s[key].map((sub: any) => run(sub, d, at)), ok = rs.filter((r: Res) => !r.errors.length);
      if (key === 'oneOf' ? ok.length !== 1 : ok.length === 0) errors.push(`${at}: ${key} matched ${ok.length}`);
      else ok.forEach((r: Res) => r.evaluated.forEach(k => evaluated.add(k)));
    }
    if (s.not && !run(s.not, d, at).errors.length) errors.push(`${at}: not`);
    if (s.unevaluatedProperties === false && isObj(d)) for (const k of Object.keys(d)) if (!evaluated.has(k)) errors.push(`${at}: unevaluated ${k}`);
    return { errors, evaluated };
  };
  return run(schema, data, '#').errors;
}

/** Parser del subconjunto YAML que emite src/export/odcs.ts (bloques, "- " y escalares JSON). */
export function parseEmittedYaml(text: string): unknown {
  const lines = text.split('\n').filter(l => l.trim() !== '').map(l => ({ indent: l.length - l.trimStart().length, body: l.trimStart() }));
  let i = 0;
  const scalar = (s: string): unknown => (s === '[]' ? [] : s === '{}' ? {} : JSON.parse(s));
  const parseKey = (body: string): [string, string] => {
    if (body.startsWith('"')) { const m = /^("(?:[^"\\]|\\.)*"):\s?(.*)$/.exec(body)!; return [JSON.parse(m[1]!), m[2]!]; }
    const idx = body.indexOf(':'); return [body.slice(0, idx), body.slice(idx + 1).trim()];
  };
  const block = (indent: number): unknown => {
    if (lines[i]!.body.startsWith('- ') || lines[i]!.body === '-') {
      const out: unknown[] = [];
      while (i < lines.length && lines[i]!.indent === indent && lines[i]!.body.startsWith('- ')) {
        const rest = lines[i]!.body.slice(2);
        lines[i] = { indent: indent + 2, body: rest };
        if (rest.startsWith('- ')) { out.push(block(indent + 2)); continue; }
        const isMapItem =/^("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_-]*):(\s|$)/.test(rest);
        out.push(isMapItem ? block(indent + 2) : (i++, scalar(rest)));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent && !lines[i]!.body.startsWith('- ')) {
      const [k, v] = parseKey(lines[i]!.body); i++;
      out[k] = v === '' ? block(lines[i]!.indent) : scalar(v);
    }
    return out;
  };
  return block(0);
}
