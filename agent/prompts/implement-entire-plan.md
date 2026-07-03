---
description: Implement a plan on its entirety, review with subagents at the very end, and iterate on important findings
argument-hint: "<PLAN.md> [review-subagents]"
---

Your goal is now to implement `$1`. During this task, don't commit the git changes until the user tells you to. If no plan file argument was provided, ask me for one before starting.
If the plan would require a substantial amount of work, divide it into major differentiated milestones. Each milestone shouldn't be too large nor too small.
If there are pending git changes, stop and ask me what to do. We'd prefer an empty git status before starting.

Follow this workflow using `${2:-1}` review subagent(s):
1. Pick the next target milestone and implement all the required changes.
2. When implementation is done, launch `${2:-1}` code review subagent(s) to review the resulting git pending changes for this milestone. As context, briefly explain to them the specific milestone and its scope.
3. If the review surfaces relevant / important items that actually deserve to be addressed, apply appropriate fixes and changes.
4. The milestone is finished now, so commit pending git changes. The git message should include "<plan name>: Milestone <milestone number> (<milestone name>)"
5. If there are more milestones ahead, go back to 1.
6. Once all milestones are completed, g ive me a final overview of everything that changed, the review outcome, and any notable caveats. Then stop there. Any plan items that are dubious, or any issues that came up during implementation, and that deserve an explicit choice by the user, must be surfaced and explained in that final overview.

