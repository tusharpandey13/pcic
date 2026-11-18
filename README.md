# pcic

Paseo Claude Idle Compaction. Compacts idle Claude Code agents that Paseo launches, while their prompt cache is still warm, and stops the first prompt after the cache expired from silently rewriting a large context. Rules: [SPEC.md](SPEC.md). This README is a placeholder.

## Install

Needs Node 20+ and Paseo 0.16.1 or newer.

```sh
git clone https://github.com/tusharpandey13/pcic && cd pcic
npm ci
paseo plugin install "$PWD"      # the Paseo plugin (server side)
node bin/pcic.mjs install        # Claude Code hooks, merged into ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json
node bin/pcic.mjs doctor         # read-only checks; exit 1 names what is missing
```

Restart the Paseo daemon after installing the plugin. For the awt brief after compaction, also run `awt init --hooks claude`.

## Configure

`${PCIC_HOME:-${XDG_DATA_HOME:-~/.local/share}/pcic}/config.json`, all keys optional. The common ones: `enabled` (true), `minContextTokens` (100000), `idleSeconds` (3300), `maxConcurrent` (2), `maxJobsPerHour` (30), `guard` (true), `checkpoint` ("awt" or "off"). The full list is in SPEC.md under Configuration. Opt one agent out with the Paseo label `pcic=off`.

## Uninstall

```sh
node bin/pcic.mjs install --uninstall
paseo plugin remove pcic         # or disable it in Paseo
```

## Test

`npm test` runs the offline suite and the type check. It spends nothing.
