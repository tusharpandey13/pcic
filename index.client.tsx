// The plugin's client entry (R45, R46). The builder looks for index.client.tsx next to index.server.ts.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ColdCard } from "./client/cold-card";
import { CARD_KIND, CARD_VERSION, TEXT_TYPES, cardDataSchema, itemText, transformText } from "./shared/cold-card";

export default function contribute(client: PluginClientContext) {
  // One transformer per text-carrying item type: which one carries hook stderr is unverified (V11).
  const offs = TEXT_TYPES.map((itemType) => client.addTimelineTransformer({ id: `pcic.cold-card.${itemType}`, query: { itemType }, transform: ({ item }: { item: unknown }) => transformText(itemText(item)) } as Parameters<typeof client.addTimelineTransformer>[0]));
  offs.push(client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: cardDataSchema, Component: ColdCard }));
  return () => { for (const off of offs) void off(); };
}
