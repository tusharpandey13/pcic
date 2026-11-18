// `npm test` entry: runs the offline suite with a private TMPDIR and fails if any `pcic-*` dir is left in it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "leakcheck-")));
const files = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".test.ts")).map((f) => join("test", f));
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=4", ...files], { stdio: "inherit", env: { ...process.env, TMPDIR: root } });
const left = readdirSync(root).filter((f) => f.startsWith("pcic-"));
rmSync(root, { recursive: true, force: true });
if (left.length) { console.error(`LEAK: the test run left ${left.length} pcic-* temp dir(s): ${left.slice(0, 5).join(", ")}`); process.exit(1); }
process.exit(r.status ?? 1);
