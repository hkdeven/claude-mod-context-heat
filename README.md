# context-heat

A Claude Code mod that shows, at a glance, how full a session's context window is and whether anything is still running. It is built around one habit: write the handoff and start a new session at about 600k tokens.

## What it does

- **A row above the message box, one per session.** It says `Working: Claude is replying`, `Working: 3 agents running` or `Idle: nothing running`, with the session's own figure (`283k of 600k`) and a strip of 240 dots, one for every 2.5k tokens. The dots run from cool blue through green, yellow and orange to red.
- **A faint background of small blocks in the desktop app.** They stack up from the bottom of the window and warm in the same colours as the context grows.
- **At 600k** the row reads `600k: write the handoff` and the background pulses slowly. From 600k to 750k everything deepens to dark red.

It reads the session's own state, so it costs no tokens.

## Install

At the prompt of a terminal session:

```
/plugin install context-heat --marketplace hkdeven/claude-mod-context-heat
```

Answer `y` to add the marketplace, then press Enter to choose the user scope.

From a shell:

```
claude plugin install context-heat --marketplace hkdeven/claude-mod-context-heat
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `hkdeven/claude-mod-context-heat`, then **Add plugin**.

Start a new session afterwards. Sessions that were already open pick the mod up when they restart.

## Good to know

- The background needs a Claude desktop app build that draws mod themes. The row works everywhere, the terminal included.
- The desktop app draws one background for the whole window, so in split view the blocks follow a single session. The row and its dots are always per session.
- Running agents are counted. Background shell commands are not visible to a mod, so they are not.
- The 600k limit is a constant, `LIMIT`, at the top of `hooks/register.tsx`.

## Develop

```
claude plugin validate .
```

```
claude plugin test .
```
