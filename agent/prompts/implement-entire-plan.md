Your goal is now to implement the plan. If no plan file was provided, ask me for one before starting.
Divide the plan into major differentiated milestones. Each milestone shouldn't be too large nor too small. Small plans may have just one milestone.
If there are pending git changes, stop and ask me what to do. We'd prefer an empty git status before starting.

You will leverage review subagents to review and verify the changes you made. If nothing was ever specified about what subagents to run and how, ask me before starting. The details of subagents usage must be clearly known.
You will launch a maximum of 3 different sets of review subagents, depending on the length of the task.

1. Prepare the milestones for plan implementation. This may imply completely redoing or adjusting existing milestones.
2. Pick the next target milestone and implement all the required changes.
3. When implementation is done, launch `${2:-1}` code review subagent(s) to review the resulting git pending changes for this milestone. As context, briefly explain to them the specific milestone and its scope.
4. If the review surfaces relevant / important items that actually deserve to be addressed, apply appropriate fixes and changes.
5. The milestone is finished now, so commit pending git changes. The git message should include "<plan name>: Milestone <milestone number> (<milestone name>)"
6. If there are more milestones ahead, go back to 1.
7. Once all milestones are completed, g ive me a final overview of everything that changed, the review outcome, and any notable caveats. Then stop there. Any plan items that are dubious, or any issues that came up during implementation, and that deserve an explicit choice by the user, must be surfaced and explained in that final overview.

