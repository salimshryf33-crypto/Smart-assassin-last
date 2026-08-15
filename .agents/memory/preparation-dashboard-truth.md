---
name: Preparation Dashboard Truth
description: The preparation operations page must derive progress and status from current per-question database states.
---

Progress shown in the preparation dashboard is the number of questions currently `READY` divided by the number of preparable questions across all supported question types. It must not use a historical job counter or an MCQ-only denominator.

**Why:** Historical preparation jobs can retain an older counter, and the previous MCQ-only calculation produced conflicting percentages for the same exam.

**How to apply:** Keep scheduler, running-job, exam-table, and progress-bar values on the same current-status source. Show paused/running queue state separately, and deduplicate active queue entries by exam.