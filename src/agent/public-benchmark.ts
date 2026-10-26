import { universeConfig } from '../universe-pipeline.ts';

/** M7-6: a universe may DECLARE that its schema is a known public benchmark, so a model can recognise it by names. The note comes from the declaration, never from guessing on model text. */
export interface PublicBenchmark { name: string; note: string }
export function publicBenchmarkOf(universe: string): PublicBenchmark | undefined {
  const declared = universeConfig(universe).publicBenchmark;
  return declared ? { name: declared.name, note: declared.note } : undefined;
}
