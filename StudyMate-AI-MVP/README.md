# StudyMate AI · MVP v0.4

Student project, Astana IT University, Technological Entrepreneurship, group CS-2420.
Team: Kassymkhan Shakabayev, Dias Tulebaev, Ilya Shestopalov.

StudyMate AI helps Grade 11 students (UNT profile maths) and Year 1–2 university students (calculus) find their gaps and close them:
Goal Check → readiness and error map → weekly plan → hint tutor → Teach-back → progress check.

## What is in this folder

| Path | What it is |
|---|---|
| `index.html` | The whole app: one HTML page with CSS and JavaScript, no build step. |
| `api/ai.js` | One serverless function for the AI helper. It holds the API key and calls the AI provider. |
| `.env.example` | The settings the function reads. Real values go into the hosting settings, never into Git. |

## Technical overview (for the report)

- **Built with:** HTML, CSS and plain JavaScript in one page; one Node.js serverless function (`api/ai.js`).
- **Data storage:** in the user's browser (`localStorage`): accounts, goal, check results, plan ticks, points.
  Passwords are stored as a salted SHA-256 hash. There is no database, so an account works only on the device and browser where it was created.
- **AI:** the page sends the learner's question to `/api/ai`; the function adds a system prompt, limits message size and requests per visitor, and calls Anthropic Claude or an OpenAI-compatible model. Without a key the app still works; AI features show a fallback (hints, live tutor).
- **Published at:** Vercel (link in the report).
- **Not yet available:** online payment (plan choice is recorded only), a shared database and login across devices, squad leaderboards, automatic mentor matching (done by the team by hand), password reset.

Test account: `demo@studymate.kz` / `demo1234` (created automatically in every browser).

## Deploy on Vercel

1. Put this folder in a GitHub repository (private is fine). Check that no `.env` file with a key is committed.
2. On vercel.com: **Add New → Project → Import** the repository. Framework preset: **Other**. No build command, no output directory.
3. **Settings → Environment Variables**: add `ANTHROPIC_API_KEY` (or `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` for Gemini or Groq). Redeploy.
4. Open `https://<project>.vercel.app/api/ai` in the browser: it must show `{"ok":true,...}`.
5. Optional: set `ALLOWED_ORIGIN` to your site address and a monthly spending limit in the AI provider's console.

Without GitHub: install the Vercel CLI (`npm i -g vercel`), run `vercel` in this folder, then `vercel env add ANTHROPIC_API_KEY` and `vercel --prod`.

## Version history

- v0.4: accounts (sign up, log in, guest, test account), saved progress and dashboard, exam date, tutor for every plan topic, progress check with new questions and a before/after view, grant chance estimate, plans and prices (pilot), Mentor Hour and weekly summaries for the mentor and parents, Study Squad invites, points and streaks, AI on the public site through `api/ai.js`.
- v0.3: KZ/RU/EN, light and dark theme, error map, term bridge, photo mistake finder, live tutor on Google Meet, AI helper inside Claude, User's Path Map.
