# Bangla 10

Minimal, mobile-first Bangla language trainer focused on daily practical conversation.

## What is built

- Daily session flow with spaced repetition flashcards
- Conversation drill stage after flashcards
- Timed quick-fire multiple-choice round
- Progress dashboard with streaks and category tracking
- Phrase bank with search and category drill-down
- Salah module with:
  - Recitation progress list
  - Chunked learning pages with audio, shadow mode, and self-rating
  - Prayer map reference
  - Wudu step-by-step guide
  - Common Islamic phrase reference
- Local backup export/import for progress data
- Beautiful warm minimal UI inspired by your mockup

## Tech

- Plain HTML, CSS, and JavaScript (no build step)
- Data stored as JSON in `data/`
- User progress stored in browser `localStorage`

## Local run

Because data is loaded with `fetch`, run from a local server (not `file://`):

```bash
cd bangla-10
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Deploy (Vercel)

1. Import this repo in Vercel.
2. Framework preset: `Other`.
3. Build command: leave empty.
4. Output directory: leave empty (root).
5. Deploy.

No environment variables are required.
