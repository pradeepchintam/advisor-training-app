# advisor-training-app

AI-powered training platform for fiduciary wealth-management advisors.

## Quickstart

```bash
docker-compose up --build
```

- Frontend (Docker): http://localhost:3000
- Frontend (dev, `npm run dev`): http://localhost:5180
- Backend API + WebSocket: http://localhost:8000

Default admin (seeded from `backend/.env` on first boot):

- Email: `admin@trajanwealth.com`
- Password: `TempAdmin123!`

## Session Profiles + Assignments

Admins build reusable client personas ("Session Profiles") and assign them to
advisors with a target date. Advisors no longer pick personas themselves for
admin-driven training — they only build personas for their own self-initiated
practice sessions.

### Admin workflow

1. **Admin → Session Profiles** (`/admin/profiles`): create a named profile
   from the full persona builder. Profiles can be edited, retired, and
   restored.
2. **Admin → Assignments** (`/admin/assignments`): pick a profile, select one
   or more advisors (fanout), set an *assigned date* and a *target date*, and
   create. Each advisor gets their own assignment row.
3. **Admin → Review Sessions** (`/admin/sessions`): every completed session is
   tagged either **Assigned** (with the originating profile name) or
   **Self-initiated** — filter the log by source.

### Advisor workflow

When an advisor logs in (`/dashboard`), the top of the page shows:

- **Today's Assigned Sessions** — assignments whose target date is today (or
  earlier, still incomplete: overdue rows are red-flagged).
- **Upcoming Sessions** — assignments with a target date in the future.

Clicking *Start Session* on a card opens `/sessions/start/:assignmentId`,
which shows the brief and starts the session with the persona locked from the
profile. The advisor cannot edit it.

A *Start Additional Session* button on the dashboard still launches the full
persona builder (`/sessions/new`) for self-initiated practice. Those sessions
are flagged "Self-initiated" in the admin log.

## Repo layout

```
backend/   FastAPI + SQLAlchemy (async) + Alembic + Anthropic Claude + AWS Polly
frontend/  React 18 + Vite + Tailwind + TypeScript
```

## Database migrations

```bash
cd backend
alembic upgrade head
```

The migration introducing session profiles + assignments is
`alembic/versions/003_session_profiles_and_assignments.py`.
