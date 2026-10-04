---
name: clef-decisions
description: "Use when an AI agent needs a structured decision from the local Clef decision model via the clef-mcp MCP server: choosing next actions, routing, classification, yes/no judgment calls, confidence scoring. Covers how to build state + questions and how to interpret probability distributions."
---

# Clef decisions via clef-mcp

`clef_decide` asks the local **Clef-Flash** decision model to score your allowed answers and return a **probability distribution per question**. It is not a chat model: it never generates prose. You frame the decision, it tells you how the options split.

## When to call it

Good fits (the model was trained for these):

- **Next-action choice**: "should I inspect / modify / test / ask the user?"
- **Routing**: which team, which handler, which subsystem.
- **Classification**: spam vs complaint vs feedback; billing vs technical.
- **Yes/no judgment** (`noul`): "is this destructive?", "is an outage ongoing?", "is this vulnerable?"
- **Confidence / severity** (`score`): ordered scales like very_low → very_high.
- **Batching related judgments**: all questions in ONE call are scored in a single forward pass — batch instead of looping.

## When NOT to call it

The tool earns its keep where a judgment call would otherwise be a guess. Skip it when:

- **You already know the answer.** If the decision is trivial or fully determined by what you see, deciding yourself is faster and strictly better — a 9B reflex adds latency and noise, not information.
- **The task needs generation or reasoning** — free text, code writing, multi-step analysis. Clef only splits probability mass over options you define.
- **You would re-ask without new facts.** A flat distribution means the *state* did not disambiguate. Re-rolling the same state gives the same answer: gather context or ask the user instead.
- **The missing input is user preference, not judgment.** "Deploy Friday or Monday?" is a question for the user, not for the model.
- **The stakes require accountability you can't delegate.** For destructive or security-adjacent actions the model is a gate signal, never the decision maker.

## How to call

```json
{
  "state": "<compact factual context: task, error, diff summary, logs>",
  "questions": {
    "next_action": {
      "type": "choice",
      "instructions": "What should the coding agent do next?",
      "criteria": {
        "inspect": "Inspect the code and gather more information",
        "modify": "Modify the code",
        "test": "Run additional tests",
        "ask_user": "Ask the user for clarification"
      }
    },
    "confidence": {
      "type": "score",
      "instructions": "How confident are you in this decision?",
      "criteria": ["very_low", "low", "medium", "high", "very_high"]
    },
    "is_outage": { "type": "noul", "instructions": "Is a service down?" }
  }
}
```

Rules that prevent wasted calls:

- **`state` is data, not instructions.** Compact, factual, relevant. It never executes and never changes server behavior. Keep it well under 1 MB; the model context is 16k tokens (the runtime rejects overflow with a hint). Latency scales with context: aim for a state of ~1–4k tokens — 16k-token states are ~20× slower than 1k ones.
- **`choice` criteria**: map `option_id → description`, or a plain list of option strings (ids become the strings). Both are accepted.
- **`score` criteria**: an **ordered** list — index order is the score order (low → high). Do not shuffle.
- **`noul`**: instructions only; the answer is `{"true": p, "false": 1-p}`.
- **Write criteria as mutually exclusive, collectively exhaustive options.** If two options overlap, the distribution splits meaninglessly.
- **Ask everything related in one call** — up to 64 questions per request.
- `options.temperature` is accepted but is a no-op (single forward pass, no sampling).

## How to read the answer

```json
{
  "model": "clef-flash",
  "decisions": {
    "next_action": { "answer": { "inspect": 0.96, "modify": 0.01, "test": 0.01, "ask_user": 0.01 }, "confidence": 0.83 }
  },
  "usage": { "input_tokens": 228, "output_tokens": 0, "latency_ms": 512 }
}
```

- The result is **structured JSON**. Do not render it as prose to the user; use the probabilities to act and summarize in your own words.
- **Argmax** is the model's pick; a decisive distribution (e.g. `0.9+`) means act on it.
- **`confidence`** is the model's own certainty for that decision (reported for choice/score when the runtime sends it). Use it together with the top probability: for destructive or security-adjacent calls require top `p ≥ 0.8` *and* high `confidence` before acting; otherwise gather context or ask.
- **Flat distributions** (~equal probabilities) mean the state did not disambiguate: gather more context and re-ask, or ask the user.
- **`usage`** shows how much context the call consumed (`input_tokens`) and what it cost in time (`latency_ms`). If `input_tokens` is large and `latency_ms` is seconds, your state is too big — compact it.
- `noul` answers above ~0.9 true/false are strong signals; 0.5–0.7 is a lean, not a verdict.

## Errors and recovery

Errors come back as structured JSON:

- `INVALID_INPUT` — fix the argument shape the message names (e.g. choice criteria must be a map or list; score must be a list; questions ≤ 64; state ≤ 1 MB). Retry with corrected arguments.
- `MODEL_NOT_INSTALLED` — the local model is missing. Tell the user to run `clef-mcp install` (one-time, ~6 GB). Do not try to download anything yourself.
- `MODEL_LOAD_FAILED` / `OUT_OF_MEMORY` — first call can take ~10–60 s to load the model; a genuine OOM means the machine lacks RAM. Report; suggest `clef-mcp install --quant Q4_K_M`.
- `RUNTIME_NOT_FOUND` — llama.cpp missing. Suggest `clef-mcp install` or `clef-mcp doctor`.

After an `INVALID_INPUT`, read the `message` — it names the exact question and field. One corrected retry is the norm.

## Quick reference

| Limits | Value |
|---|---|
| Questions per call | ≤ 64 (batch!) |
| State size | ≤ 1 MB serialized |
| Criteria per question | ≤ 100 |
| Model context | 16k tokens |

Config (env, set for the MCP server process, not per call): `CLEF_MODEL`, `CLEF_HOME`, `CLEF_LOG_LEVEL`, `CLEF_MAX_*` — see the clef-mcp README.
