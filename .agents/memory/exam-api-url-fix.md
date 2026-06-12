---
name: Exam API URL mismatch fix
description: curriculumApi.ts used wrong base URL for exam record endpoints; routes are under /records/ prefix.
---

## Rule
All exam record CRUD endpoints in `curriculumApi.ts` must use `RECS = '/api/exams/records'`, NOT the bare `EXAM = '/api/exams'`.

## Why
The Express router mounts exam routes with a `/records/` prefix:
- `GET /api/exams/records` — list
- `GET /api/exams/records/:id` — single
- `DELETE /api/exams/records/:id` — delete
- `GET /api/exams/records/:id/questions` — questions

The bare `/api/exams` has no handler → 404 → silent empty array → entire "امتحاناتي" tab always empty.

## How to apply
- `listExamRecords` → `fetch(RECS)`
- `getExamRecord` → `fetch(\`\${RECS}/\${id}\`)`
- `deleteExamRecord` → `DELETE \${RECS}/\${id}`
- `getExamQuestions` → `fetch(\`\${RECS}/\${id}/questions\`)`
- Question bank search → `GET \${EXAM}/questions` (no /records/ prefix — different route)
