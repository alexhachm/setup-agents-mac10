# Worker Lessons

Lessons from fix reports. Appended by Master-1 when processing user fix requests.
Read by workers on startup to avoid repeating known issues.

<!-- Format:
## [date] — [brief title]
- Lesson: [what to watch for next time]
-->

## 2026-02-27 — Popout non-functional on web app
- Lesson: Popout/window detach functionality needs end-to-end testing on the web app separately from desktop — they may diverge silently.

## 2026-02-27 — Charts non-functional (recurring)
- Lesson: Charts have been broken multiple times. After any chart-related change, verify end-to-end chart rendering before marking complete.
