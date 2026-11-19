import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPcic } from "./server/scheduler.js";
import { chooseRpc } from "./shared/cold-card.js";

export default function contribute(server: PluginServerContext) {
  const pcic = createPcic({ env: process.env });
  const offs = (Object.entries(pcic.hooks) as [string, (p: any, c: any) => Promise<any>][]).map(([name, fn]) => (server as any).addHook(name, fn) as () => void);
  server.handle(chooseRpc, (input, { paseo }) => pcic.choose(input, paseo as any)); // R47
  const unwatch = pcic.watchCards(); // R48
  const timer = setInterval(() => void pcic.sweep(), pcic.config().sweepSeconds * 1000);
  timer.unref?.();
  return () => { clearInterval(timer); unwatch(); offs.forEach((f) => f()); pcic.cleanup(); };
}
