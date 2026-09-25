require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const claude = require('./lib/claude');
const transcribe = require('./lib/transcribe');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3004;

// How aggressively the rolling summary refreshes while recording.
const SUMMARY_MIN_INTERVAL_MS = Number(process.env.SUMMARY_MIN_INTERVAL_MS || 30000);
const SUMMARY_MIN_NEW_CHARS = Number(process.env.SUMMARY_MIN_NEW_CHARS || 280);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * REST API
 * ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    anthropic: claude.hasApiKey(),
    transcription: transcribe.hasApiKey()
  });
});

app.get('/api/meetings', async (req, res) => {
  try {
    const list = await store.listMeetings({ q: req.query.q });
    res.json({ meetings: list });
  } catch (err) { fail(res, err); }
});

app.get('/api/meetings/:id', async (req, res) => {
  try {
    const meeting = await store.getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
    res.json({ meeting });
  } catch (err) { fail(res, err); }
});

app.patch('/api/meetings/:id', async (req, res) => {
  try {
    const patch = {};
    if (typeof req.body.title === 'string') patch.title = req.body.title.trim() || 'Untitled meeting';
    const meeting = await store.updateMeeting(req.params.id, patch);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
    res.json({ meeting });
  } catch (err) { fail(res, err); }
});

app.delete('/api/meetings/:id', async (req, res) => {
  try {
    const ok = await store.deleteMeeting(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Meeting not found.' });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/**
 * Upload an audio file (transcribed with speaker diarization) or a text
 * transcript, then summarize the whole thing in one go.
 */
app.post('/api/meetings/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    const name = req.file.originalname || 'recording';
    let segments;

    if (transcribe.isAudioFile(name, req.file.mimetype)) {
      const diarize = req.body.diarize !== 'false';
      const result = await transcribe.transcribeAudio(req.file.buffer, name, { diarize });
      segments = result.segments;
    } else {
      segments = transcribe.parseTextTranscript(req.file.buffer.toString('utf8'));
    }

    if (!segments.length) {
      return res.status(400).json({ error: 'No speech could be extracted from this file.' });
    }

    const meeting = await store.createMeeting({
      title: name.replace(/\.[^.]+$/, ''),
      source: 'upload'
    });

    const lastTs = segments[segments.length - 1].ts || 0;
    await store.updateMeeting(meeting.id, {
      segments,
      speakers: [...new Set(segments.map((s) => s.speaker))],
      durationSec: lastTs,
      status: 'done'
    });

    // Summarize; if this fails the transcript is still saved, so report
    // the error without throwing the whole meeting away.
    let summary = null;
    let summaryError = null;
    try {
      summary = await claude.generateSummary(segments, 'final');
      await store.updateMeeting(meeting.id, {
        summary,
        title: summary.title || meeting.title
      });
    } catch (err) {
      console.error('Summary failed for uploaded meeting:', err.message);
      summaryError = err.message;
    }

    const saved = await store.getMeeting(meeting.id);
    res.json({ meeting: saved, summaryError });
  } catch (err) { fail(res, err); }
});

function fail(res, err) {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error.',
    details: err.details
  });
}

/* ------------------------------------------------------------------ *
 * WebSocket: live transcription sessions
 *
 * Clients join a "room" identified by meetingId. Transcript segments sent
 * by one client are broadcast to everyone watching that meeting, and the
 * server periodically asks Claude for a refreshed rolling summary.
 * ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, path: '/ws' });

/** meetingId -> { sockets:Set, lastSummaryAt:number, charsSinceSummary:number, summarizing:boolean } */
const rooms = new Map();

function getRoom(meetingId) {
  if (!rooms.has(meetingId)) {
    rooms.set(meetingId, {
      sockets: new Set(),
      lastSummaryAt: 0,
      charsSinceSummary: 0,
      summarizing: false
    });
  }
  return rooms.get(meetingId);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(meetingId, payload, exclude) {
  const room = rooms.get(meetingId);
  if (!room) return;
  for (const ws of room.sockets) {
    if (ws !== exclude) send(ws, payload);
  }
}

wss.on('connection', (ws) => {
  ws.meetingId = null;

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Malformed message.' });
    }

    try {
      switch (msg.type) {
        case 'session:start': return await handleStart(ws, msg);
        case 'session:join': return await handleJoin(ws, msg);
        case 'segment': return await handleSegment(ws, msg);
        case 'summary:request': return await runSummary(ws.meetingId, 'live', true);
        case 'session:stop': return await handleStop(ws, msg);
        default:
          return send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('WebSocket handler error:', err);
      send(ws, { type: 'error', message: err.message || 'Something went wrong.' });
    }
  });

  ws.on('close', () => {
    if (ws.meetingId && rooms.has(ws.meetingId)) {
      const room = rooms.get(ws.meetingId);
      room.sockets.delete(ws);
      if (room.sockets.size === 0) rooms.delete(ws.meetingId);
    }
  });
});

async function handleStart(ws, msg) {
  const meeting = await store.createMeeting({
    title: (msg.title || '').trim() || `Meeting — ${new Date().toLocaleString()}`,
    source: 'live'
  });
  ws.meetingId = meeting.id;
  getRoom(meeting.id).sockets.add(ws);
  send(ws, { type: 'session:started', meeting });
}

async function handleJoin(ws, msg) {
  const meeting = await store.getMeeting(msg.meetingId);
  if (!meeting) return send(ws, { type: 'error', message: 'Meeting not found.' });
  ws.meetingId = meeting.id;
  getRoom(meeting.id).sockets.add(ws);
  send(ws, { type: 'session:joined', meeting });
}

async function handleSegment(ws, msg) {
  if (!ws.meetingId) {
    return send(ws, { type: 'error', message: 'Start a session before sending transcript.' });
  }
  const text = (msg.text || '').trim();
  if (!text) return;

  const segment = {
    speaker: (msg.speaker || 'Speaker 1').trim(),
    text,
    ts: Number(msg.ts) || 0
  };

  await store.appendSegment(ws.meetingId, segment);
  await store.updateMeeting(ws.meetingId, { durationSec: segment.ts });

  // Echo to everyone else watching this meeting.
  broadcast(ws.meetingId, { type: 'segment', segment }, ws);

  const room = getRoom(ws.meetingId);
  room.charsSinceSummary += text.length;
  maybeSummarize(ws.meetingId);
}

/** Refresh the rolling summary only when enough has been said and enough time has passed. */
function maybeSummarize(meetingId) {
  const room = rooms.get(meetingId);
  if (!room || room.summarizing) return;

  const enoughText = room.charsSinceSummary >= SUMMARY_MIN_NEW_CHARS;
  const enoughTime = Date.now() - room.lastSummaryAt >= SUMMARY_MIN_INTERVAL_MS;
  if (!enoughText || !enoughTime) return;

  runSummary(meetingId, 'live', false);
}

async function runSummary(meetingId, mode, forced) {
  if (!meetingId) return;
  const room = getRoom(meetingId);

  if (room.summarizing) {
    if (forced) broadcast(meetingId, { type: 'summary:pending' });
    return;
  }

  const meeting = await store.getMeeting(meetingId);
  if (!meeting || !meeting.segments.length) {
    if (forced) {
      broadcast(meetingId, { type: 'error', message: 'Nothing has been transcribed yet.' });
    }
    return;
  }

  room.summarizing = true;
  broadcast(meetingId, { type: 'summary:pending' });

  try {
    const summary = await claude.generateSummary(meeting.segments, mode);
    const patch = { summary };
    // Let the AI name the meeting, unless the user renamed it themselves.
    if (summary.title && /^(Untitled meeting|Meeting — )/.test(meeting.title)) {
      patch.title = summary.title;
    }
    const updated = await store.updateMeeting(meetingId, patch);

    room.lastSummaryAt = Date.now();
    room.charsSinceSummary = 0;
    broadcast(meetingId, { type: 'summary', summary, title: updated.title });
  } catch (err) {
    console.error('Summary generation failed:', err.message);
    // Back off: without this, a failing API key would trigger a retry on
    // every single new segment. Treat the failed attempt as "just ran"
    // so the normal interval gate applies before trying again.
    room.lastSummaryAt = Date.now();
    room.charsSinceSummary = 0;
    broadcast(meetingId, { type: 'summary:error', message: err.message });
  } finally {
    room.summarizing = false;
  }
}

async function handleStop(ws, msg) {
  const meetingId = ws.meetingId || msg.meetingId;
  if (!meetingId) return;

  await store.updateMeeting(meetingId, { status: 'done' });

  // One last pass over the full transcript, in 'final' mode.
  const room = getRoom(meetingId);
  room.lastSummaryAt = 0;
  room.charsSinceSummary = Number.MAX_SAFE_INTEGER;
  await runSummary(meetingId, 'final', true);

  const meeting = await store.getMeeting(meetingId);

  // broadcast() already reaches this socket when it joined the room, so
  // only send directly when it didn't (e.g. a stop sent without joining).
  const inRoom = room.sockets.has(ws);
  broadcast(meetingId, { type: 'session:stopped', meeting });
  if (!inRoom) send(ws, { type: 'session:stopped', meeting });
}

server.listen(PORT, () => {
  console.log(`MeetScribe is running at http://localhost:${PORT}`);
  if (!claude.hasApiKey()) {
    console.warn('⚠️  ANTHROPIC_API_KEY is not set — summaries will fail. Copy .env.example to .env.');
  }
  if (!transcribe.hasApiKey()) {
    console.log('ℹ️  OPENAI_API_KEY not set — live recording works, audio file upload does not.');
  }
});
