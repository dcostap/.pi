---
description: Implement a plan on its entirety, review with subagents at the very end, and iterate on important findings
argument-hint: "<PLAN.md> [review-subagents]"
---
Follow this workflow for `$1` using `${2:-1}` review subagent(s):

1. Start implementing `$1`. If no plan file argument was provided, ask me for one before starting. Do not commit.
2. When implementation is done, launch `${2:-1}` code review subagent(s) to review the resulting changes. If the requested count is greater than 4, launch 4 and mention the limit.
3. If the review surfaces relevant, important items that actually deserve to be addressed, apply appropriate fixes, then go back to step 2 for another review pass as needed.
4. If no more important review items remain, give me a final overview of everything that changed, the review outcome, and any notable caveats. Then stop there.
5. Any plan items that are dubious, or any issues that came up during implementation, and that deserve an explicit choice by the user, must be surfaced and explained in that final overview.

Do not commit at any point.
