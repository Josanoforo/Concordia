/** Offline dependencies of the agent loop, shared by `agent --offline` and `eval-agent` so both run the same configuration. */
import { catalogOf } from './catalog.ts';
import type { ActionChooser } from './chooser.ts';
import type { AgentDeps } from './engine.ts';
import { fixtureClient } from '../eval/fixture-client.ts';
import { nameTokenComaBridge, scriptedComaBridge, type ScriptedComaProposal } from '../eval/fixture-coma.ts';
import { universeConfig } from '../universe-pipeline.ts';

/** LOCAL + SYNTHETIC over the fixture's tables; blind universes get the offline name-token COMA stand-in (no COMA provider runs offline). */
export function offlineAgentDeps(universe: string, fixture: { tables: any; comaProposals?: readonly ScriptedComaProposal[] }, chooser: ActionChooser | undefined): Pick<AgentDeps, 'client' | 'chooser' | 'comaBridge' | 'executionMode' | 'dataOrigin'> {
  const cfg = universeConfig(universe);
  return { client: fixtureClient(cfg, fixture.tables) as any, chooser, comaBridge: catalogOf(cfg)?.postComa?.blind === true ? (fixture.comaProposals ? scriptedComaBridge(fixture.comaProposals) : nameTokenComaBridge) : undefined, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' };
}
