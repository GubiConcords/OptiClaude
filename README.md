# OptiClaude

*unbeatable efficiency*

A Claude Code mod that predicts a prompt's token cost before you send it and recommends a model and effort for the task (Haiku for "fix all typos", Opus for a migration). Everything is computed locally: using the mod costs 0 tokens.

- **OC** button above the prompt opens the panel
- Prompt estimate: this prompt, context re-read on send, expected whole turn (learns from your real turns)
- Recommended model and effort, with "Use for next prompt" and Auto mode
- Session and weekly usage bars
- Cache countdown: how long the prompt cache stays warm (5 min after the last request)
- Cost of the last turn, this session and a running total across sessions
- Burn rate of the session limit and when you'd hit it at this pace
- What fills the context, with a warning before auto-compaction
- Biggest tool outputs, tool call and subagent counts, input, cache, output and thinking tokens
- Per-model usage split

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install opticlaude --marketplace GubiConcords/OptiClaude
```

From a shell:

```bash
claude plugin install opticlaude --marketplace GubiConcords/OptiClaude
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GubiConcords/OptiClaude`, then **Add plugin**.
