/**
 * R10b: a forced tool call can return the arguments with a different ENCODING of the same content. Live, the adversary's nested array of objects came back in four shapes (25 of 182 answers
 * read as INVALID; the judges, with a flat schema, 0 of 260):
 *   F0  a field the schema types array/object, as a JSON string that holds it                        "attacks":"[{...},{...}]"
 *   F1  that string with the closing brace of the OBJECT inside it (ends in `]}`, sometimes `]}` + newline): JSON.parse fails, so only trailing `}` and whitespace are dropped, once
 *   F2  the string holds an object whose only key is the field itself                                "attacks":"{\"attacks\":[...]}"
 *   F3  the arguments wrapped under an extra `argument` key that holds the schema's fields           {"argument":{"relationId":...,"attacks":[...]}}
 * The content is the model's own, complete and unchanged. `normalizeToolArguments` undoes only the encoding, driven by the tool's own schema, and the strict parsers then run on the result:
 * a value is taken only if it has EXACTLY the type the schema declares, and anything the schema still refuses after that stays INVALID (no retry). It adds no field, drops no value,
 * changes no value and repairs nothing semantic. What was done is returned as `normalized` (`attacks:json-string`, `attacks:json-string+trailing-brace`, `attacks:json-string+unwrapped`,
 * `root:argument-wrapper`), so a report can count it. It applies to a tool call's arguments only, never to message text.
 */
import { modelJsonText } from '../model-json.ts';
import { toolFor } from './tool-schemas.ts';
import type { TraceStage } from './types.ts';

interface SchemaNode { type?: string; properties?: Record<string, SchemaNode>; items?: SchemaNode }
export const JSON_STRING_NORMALIZATION = 'json-string';
/** The only wrapper key a root may carry (F3). */
export const ARGUMENT_WRAPPER_KEY = 'argument';

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasType = (schema: SchemaNode, value: unknown) => (schema.type === 'array' ? Array.isArray(value) : isPlainObject(value));
const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };
/** F1: the closing brace of the enclosing object inside the string. Only `}` and whitespace at the end are dropped; what is left must parse as an array. */
const withoutTrailingBraces = (text: string) => text.replace(/[}\s]+$/, '');

/**
 * A string at a place the schema types array/object. `field` is the name of the property (absent for an array item). One decoding per place: a parse that is itself a string is not decoded again.
 */
function decode(schema: SchemaNode, text: string, path: string, field: string | undefined, notes: string[]): unknown {
  const label = (suffix = '') => `${path}:${JSON_STRING_NORMALIZATION}${suffix}`;
  let parsed = tryParse(text);
  if (parsed.ok && hasType(schema, parsed.value)) { notes.push(label()); return parsed.value; }
  // F2: the string holds an object whose single key is this field, and what it holds has the declared type.
  if (parsed.ok && field !== undefined && isPlainObject(parsed.value)) {
    const keys = Object.keys(parsed.value);
    if (keys.length === 1 && keys[0] === field && hasType(schema, parsed.value[field])) { notes.push(label('+unwrapped')); return parsed.value[field]; }
  }
  // F1: the string does not parse. An array cut at its own `]` parses; nothing else is tried.
  if (!parsed.ok && schema.type === 'array') {
    const trimmed = withoutTrailingBraces(text);
    if (trimmed !== text) { parsed = tryParse(trimmed); if (parsed.ok && Array.isArray(parsed.value)) { notes.push(label('+trailing-brace')); return parsed.value; } }
  }
  return text;
}

function walk(schema: SchemaNode, value: unknown, path: string, field: string | undefined, notes: string[]): unknown {
  let current = value;
  if (typeof current === 'string' && (schema.type === 'array' || schema.type === 'object')) current = decode(schema, current, path, field, notes);
  if (schema.type === 'object' && schema.properties && isPlainObject(current)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) out[key] = schema.properties[key] ? walk(schema.properties[key]!, item, path ? `${path}.${key}` : key, key, notes) : item;
    return out;
  }
  if (schema.type === 'array' && schema.items && Array.isArray(current)) return current.map((item, index) => walk(schema.items!, item, `${path}[${index}]`, undefined, notes));
  return current;
}

/**
 * F3: the arguments wrapped under `argument`. The root must be made of schema properties plus that one key, `argument` must be an object made of schema properties only, and a property
 * present at both levels must be equal (relationId in particular). Otherwise the root is left as it came and the parser refuses it.
 */
function unwrapRoot(schema: SchemaNode, root: Record<string, unknown>): Record<string, unknown> | undefined {
  const wrapper = root[ARGUMENT_WRAPPER_KEY], properties = schema.properties ?? {};
  if (!(ARGUMENT_WRAPPER_KEY in root) || ARGUMENT_WRAPPER_KEY in properties || !isPlainObject(wrapper) || !Object.keys(wrapper).length) return undefined;
  const outer = Object.keys(root).filter(key => key !== ARGUMENT_WRAPPER_KEY);
  if (!outer.every(key => key in properties) || !Object.keys(wrapper).every(key => key in properties)) return undefined;
  for (const key of outer) if (key in wrapper && JSON.stringify(root[key]) !== JSON.stringify(wrapper[key])) return undefined;
  return { ...Object.fromEntries(outer.map(key => [key, root[key]])), ...wrapper };
}

/** The text to hand to the strict parser, and what was normalized to get it. `text` is the input untouched when nothing was. */
export function normalizeToolArguments(stage: TraceStage, text: string): { text: string; normalized: string[] } {
  const parsed = tryParse(modelJsonText(text));
  if (!parsed.ok || !isPlainObject(parsed.value)) return { text, normalized: [] };
  const schema = toolFor(stage).function.parameters as SchemaNode, notes: string[] = [];
  const unwrapped = unwrapRoot(schema, parsed.value);
  if (unwrapped) notes.push(`root:${ARGUMENT_WRAPPER_KEY}-wrapper`);
  const fixed = walk(schema, unwrapped ?? parsed.value, '', undefined, notes);
  return notes.length ? { text: JSON.stringify(fixed), normalized: notes } : { text, normalized: [] };
}
