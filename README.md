# MeetScribe 🎙️

A live meeting assistant: it transcribes as people speak, labels who said what, and keeps a running summary with action items that updates **while the meeting is still going**.

## What it does

**Record mode** — press start and speak. The transcript builds up line by line, and every ~30 seconds the summary panel refreshes with what has been discussed, the decisions made, and the action items so far. Mark who is speaking with a click (or number keys 1–9).

**Upload mode** — drop in an audio file and it gets transcribed with automatic speaker detection, then summarized in one pass.

**Library** — every meeting is stored on the server and searchable across transcripts, summaries, decisions and action items.

## How it works

This is the first project in the series with a real-time backend, so here's the shape of it:

```
Browser                          Server                      APIs
───────                          ──────                      ────
SpeechRecognition ──┐
  (speech → text)   │
                    ├─ WebSocket ─→ accumulates transcript
Speaker buttons ────┘   /ws        ├─→ saves to data/meetings.json
                                   └─→ every ~30s ──────────→ Anthropic
Summary panel  ←──── WebSocket ←──── pushes refreshed summary    (Claude)

Audio upload ────── POST /api/ ───→ transcribe + diarize ────→ OpenAI
                    meetings/upload └─→ summarize ───────────→ Anthropic
```

- **Live speech-to-text runs in your browser**, not on the server. Only the resulting text is transmitted — the audio never leaves your machine in record mode.
- **WebSockets** carry transcript segments up and summaries back down. Several people can open the same meeting and watch the transcript fill in together.
- **Speaker diarization** for uploaded audio uses OpenAI's `gpt-4o-transcribe-diarize`, which returns segments tagged by speaker. In live mode you tag speakers yourself, since browser speech recognition can't tell voices apart.

## Project structure

```
meetscribe/
├── server.js              # Express + WebSocket server, REST routes
├── lib/
│   ├── store.js           # JSON-file persistence (atomic, serialized writes)
│   ├── claude.js          # summary generation (rolling + final modes)
│   └── transcribe.js      # audio transcription + speaker diarization
├── public/
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── main.js        # UI wiring, tabs, library, detail view
│       ├── live.js        # SpeechRecognition + WebSocket client
│       └── render.js      # pure rendering helpers
├── data/                  # created at runtime, holds meetings.json (gitignored)
├── package.json
├── .env.example
└── README.md
```

## Installation

1. You'll need [Node.js](https://nodejs.org/) 18 or newer.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
4. Add your Anthropic key to `.env` (required — this generates the summaries):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Optionally add an OpenAI key too, if you want to upload audio files:
   ```
   OPENAI_API_KEY=sk-...
   ```
5. Start it:
   ```bash
   npm start
   ```
6. Open [http://localhost:3004](http://localhost:3004).

> **Browser note:** live recording uses the Web Speech API, which works in **Chrome and Edge**. Firefox and Safari don't support it — the app detects this and tells you, and the Upload tab still works everywhere.
>
> Runs on port **3004**, so it coexists with the other projects in this series.

## Costs to be aware of

- Summaries call the Anthropic API roughly every 30 seconds while recording. A one-hour meeting is around 120 calls. Adjust `SUMMARY_MIN_INTERVAL_MS` in `.env` to make it less chatty.
- Browser speech recognition is free.
- Audio upload transcription is billed per minute of audio by OpenAI.

## Features

**Core**
- Live transcription with interim (grey) and confirmed (black) text
- Manual speaker tagging, renameable, with keyboard shortcuts
- Rolling summary refreshed during the meeting, plus a fuller one at the end
- Summary, key points, decisions, action items (with owner and deadline), topics
- Audio upload with automatic speaker diarization
- Plain `.txt` / `.vtt` / `.srt` transcript import

**Around it**
- Server-side storage, so meetings survive browser changes and are shared across devices on the same machine
- Full-text search across transcripts, summaries and action items
- Rename meetings inline, copy notes, download as `.txt`, delete
- Multiple browser tabs can watch the same live meeting

## Known limits

- Live mode can't tell voices apart — that's why speaker tagging is manual there.
- Browser speech recognition quality varies with microphone and accent; it's noticeably better for English than for smaller languages.
- Audio uploads are capped at 25 MB by the transcription API. Longer recordings need to be split first.
- Storage is a JSON file, which is fine for personal use but would want a real database for a team.

## Ideas for next steps

- Save the microphone audio alongside the transcript (MediaRecorder) so meetings can be replayed
- Per-speaker voice fingerprints, so live mode can label speakers automatically
- Export action items to a task manager
- Ask questions about past meetings ("what did we decide about the deadline?") via semantic search
- Swap the JSON store for SQLite once the library gets large

## Pushing to GitHub

```bash
cd meetscribe
git init
git add .
git commit -m "Initial commit: MeetScribe"
git branch -M main
git remote add origin <your_github_repo_url>
git push -u origin main
```

Both `.env` and `data/` are gitignored — your API keys and your meeting transcripts stay on your machine.
