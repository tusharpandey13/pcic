// R46: the card. Thin on purpose: every decision (labels, texts, ids) comes from shared/cold-card.ts, which is tested offline.
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { chooseRpc, pendingText, resultText, viewModel, type CardData, type NoteData } from "../shared/cold-card";

/** R52: one small grey row (same renderer as the card, a data variant). */
export function ColdCard({ item, theme }: PluginTimelineItemProps<CardData | NoteData>) {
  const data = item.data;
  if ("note" in data) return <View style={{ paddingVertical: 4, paddingHorizontal: 12 }}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{data.note}</Text></View>;
  return <Card data={data} theme={theme} />;
}

function Card({ data, theme }: { data: CardData; theme: PluginTimelineItemProps<CardData>["theme"] }) {
  const choose = useRpc(chooseRpc);
  const view = viewModel(data);
  const [picked, setPicked] = useState<string>(view.options[0]?.id ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [state, setState] = useState<"choosing" | "pending" | "done">("choosing");
  const c = theme.colors;

  const submit = async (id: string | "dismiss") => {
    const opt = view.options.find((o) => o.id === id);
    const choice = id === "dismiss" ? "dismiss" : opt?.choice;
    if (!choice) return;
    setState("pending"); setNote(choice === "dismiss" ? "Dismissing" : pendingText(choice, data.awt));
    try {
      const r = await choose({ cardId: data.cardId, choice, always: !!opt?.always });
      const res = resultText(choice, data.awt, r);
      setNote(res.text); setState(res.retry ? "choosing" : "done");
    } catch (e) {
      setNote(resultText(choice, data.awt, { status: "failed", detail: e instanceof Error ? e.message : "error" }).text); setState("done");
    }
  };

  if (view.auto) return <View style={{ paddingVertical: 4, paddingHorizontal: 12 }}><Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{view.auto}</Text></View>;
  return (
    <View style={{ padding: 12, gap: 8, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{view.header}</Text>
      {state === "choosing" ? view.options.map((o) => (
        <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ selected: picked === o.id }} onPress={() => setPicked(o.id)} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ color: picked === o.id ? c.accent : c.foregroundMuted }}>{picked === o.id ? "(o)" : "( )"}</Text>
          <Text style={{ color: picked === o.id ? c.foreground : c.foregroundMuted, flexShrink: 1 }}>{o.label}</Text>
        </Pressable>
      )) : null}
      {note ? <Text style={{ color: c.foregroundMuted }}>{note}</Text> : null}
      {state === "choosing" ? (
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Pressable accessibilityRole="button" onPress={() => void submit("dismiss")} style={{ paddingVertical: 6, paddingHorizontal: 12 }}><Text style={{ color: c.foregroundMuted }}>Dismiss</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => void submit(picked)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: c.accent }}><Text style={{ color: c.accentForeground }}>Submit</Text></Pressable>
        </View>
      ) : null}
    </View>
  );
}
