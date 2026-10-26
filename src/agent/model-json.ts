/**
 * The JSON text of a model response. Strict, with one tolerated wrapper: exactly one Markdown code fence (```json ... ``` or ``` ... ```)
 * and nothing else but whitespace outside it. Two blocks, text before or after, or another language tag are returned untouched, so the
 * caller's JSON.parse rejects them. What is inside is still parsed and validated by the caller.
 */
export function modelJsonText(text: string): string {
  const match = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/i.exec(text.trim());
  return match && !match[1]!.includes('```') ? match[1]! : text;
}
