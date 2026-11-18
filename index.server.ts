import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPcic } from "./server/scheduler.js";

export default function contribute(server: PluginServerContext) {
  const pcic = createPcic({ env: process.env });
  const offs = (Object.entries(pcic.hooks) as [string, (p: any, c: any) => Promise<any>][]).map(([name, fn]) => (server as any).addHook(name, fn) as () => void);
  const timer = setInterval(() => void pcic.sweep(), pcic.config().sweepSeconds * 1000);
  timer.unref?.();
  return () => { clearInterval(timer); offs.forEach((f) => f()); pcic.cleanup(); };
}
