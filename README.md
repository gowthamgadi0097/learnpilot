# LearnPilot: B.Tech AI Tutor (complete app)

One folder, one command. The Node server runs the API, the database (SQLite) and the web app.

```
learnpilot-app/
├── server.js        backend: login, approvals, courses, quizzes, results, AI
├── public/
│   └── index.html   the web app (teacher portal + student portal)
├── package.json
├── .env.example     template for .env (created for you on first start)
├── render.yaml      one-click deploy settings for Render
├── Dockerfile       deploy anywhere that runs Docker
├── scripts/setup.js creates .env automatically
├── .vscode/         Run (F5), tasks and extension tips for VS Code
└── README.md
```

## Run it in VS Code (about 3 minutes)

1. Install **Node.js 18 or newer** (nodejs.org) and **VS Code**.
2. Unzip `learnpilot-app.zip`. In VS Code choose **File > Open Folder** and pick the `learnpilot-app` folder (click "Yes, I trust the authors").
3. Open the terminal in VS Code (**Terminal > New Terminal**) and run:
   ```
   npm install
   npm start
   ```
   The first `npm start` creates your `.env` file for you.
   Prefer buttons? Press **F5** ("Run LearnPilot") or use **Terminal > Run Task** ("1. Install packages", then "2. Start LearnPilot").
4. Open **http://localhost:3000** (F5 opens it for you).
5. For the AI features, open the new `.env` file, paste your key after `ANTHROPIC_API_KEY=` (from console.anthropic.com), save, and restart (Ctrl+C, then `npm start`). Without a key everything else works.

**Teacher login:** `teacher@college.edu` / `ChangeMe123`. To change it, edit `TEACHER_EMAIL` and `TEACHER_PASSWORD` in `.env`, delete the `learnpilot.db` file, and restart (the teacher account is only created the first time).
**Students:** open the page and choose **New student? Register**.

## How it works

- **Students register** with name, college, branch, year, roll no., email and password. Roll no. must be 10 characters starting with `24KX` (example `24KX1A3010`).
- **One roll no. = one account.** If someone registers with a roll no. that is already taken, the attempt is refused and a **Security alert** appears in the teacher portal.
- New students sit on the **waiting list** until the teacher approves them into specific **courses**. Students only ever see the courses they were approved for.
- **Only the teacher** can generate and publish quizzes, exams and assignments (AI drafts them; the teacher reviews and publishes). Quiz/exam answers are never sent to the student's browser before submission, and each can be attempted once.
- The teacher can delete single items, all content in a course, a course, one student, all waiting or approved students, alerts, or everything (Danger zone).
- Students can edit their name/college/branch/year (roll no. is locked), and delete their own account, which frees the roll no.

## Deploy it (put it online for students)

### Step 1: Put the code on GitHub (from VS Code)
1. In VS Code, click the **Source Control** icon in the left bar, then **Initialize Repository**.
2. Type a message (for example "LearnPilot") and click **Commit**. The `.gitignore` already keeps your `.env` and the database out.
3. Click **Publish Branch**, sign in to GitHub, and choose a **private** repository.

### Step 2: Deploy on Render (recommended)
1. On render.com choose **New > Blueprint**, connect GitHub, and pick your repository. Render reads the included `render.yaml`.
2. It asks you for three values: `TEACHER_EMAIL`, `TEACHER_PASSWORD` (8+ characters, not `ChangeMe123`; the app refuses to start in production with the default) and `ANTHROPIC_API_KEY`.
3. Use a **paid plan**. The database is a file, and Render's free plan erases local files on every restart or redeploy, which would delete all your students and results. `render.yaml` attaches a 1 GB persistent disk, which only paid plans support.
4. When the deploy finishes, Render gives you an address like `https://learnpilot-xxxx.onrender.com`. Share that with students. You log in as teacher with the email and password you entered.

### Other hosts (Docker)
A `Dockerfile` is included. On Railway, Fly.io or your own server: build the image, mount a persistent volume at `/data`, and set `NODE_ENV=production`, `JWT_SECRET` (long random text), `TEACHER_EMAIL`, `TEACHER_PASSWORD` and `ANTHROPIC_API_KEY`.

### Built-in protections for a public site
- 8 wrong passwords in 15 minutes locks that email on that connection for 15 minutes.
- One security alert per roll no. and email, so alerts cannot be flooded.
- Security headers, and cross-site access is switched off.
- The default teacher password is refused in production.

## API summary (all under /api, send `Authorization: Bearer <token>`)

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET/PATCH/DELETE /me` |
| Teacher | `GET/POST /courses`, `DELETE /courses/:id`, `GET/POST /courses/:id/items`, `DELETE /courses/:id/items`, `DELETE /items/:id`, `POST /ai/generate`, `GET /students`, `POST /students/:id/approve\|decline\|remove`, `DELETE /students/:id`, `DELETE /students?status=waiting\|approved`, `GET/DELETE /alerts`, `DELETE /alerts/:id`, `GET /results`, `DELETE /all` |
| Student (approved) | `GET /my/courses`, `POST /items/:id/submit`, `GET /my/progress`, `POST /ai/tutor`, `POST /ai/plan` |

## Before real classroom use

- Use a strong teacher password.
- There is no email verification or password reset. If a student forgets a password, the teacher can delete the student so they can register again.
- Roll numbers are checked only for format and uniqueness, not against an official roster.
- Back up the `.db` file regularly.
