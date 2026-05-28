---
description: Ouptut a self-contained review prompt of the latest feature
argument-hint: "[extra notes]"
---
You will now output a self-contained prompt that we will feed another review AI agent.
Its goal will be to do a read-only review that identifies any possible regressions, bugs, oversights, missing features, etc (regarding the last feature / implementation we just did).
You will dump the needed context: what we tried to implement, what the goals were, what the explicit non-goals were. Don't give any more context.
The dump mustn't be too extensive. The review agent will know how to search the codebase and look around, we just give it the minimum context needed.

$ARGUMENTS
