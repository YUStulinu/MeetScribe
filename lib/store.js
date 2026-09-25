/**
 * store.js — simple JSON-file persistence for meetings.
 *
 * Everything lives in data/meetings.json. Writes are serialized through a
 * promise chain so two concurrent saves can never interleave and corrupt
 * the file, and each write goes to a temp file first, then gets renamed
 * (an atomic operation on most filesystems).
 */
const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'meetings.json');

let cache = null;        // in-memory copy of all meetings
let writeChain = Promise.resolve(); // serializes writes

async function ensureLoaded() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = { meetings: [] };
    } else {
      console.error('Could not read data file, starting empty:', err.message);
      cache = { meetings: [] };
    }
  }
  if (!Array.isArray(cache.meetings)) cache.meetings = [];
  return cache;
}

function persist() {
  // Queue this write behind any write already in flight.
  writeChain = writeChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
  }).catch((err) => {
    console.error('Failed to persist data:', err.message);
  });
  return writeChain;
}

function newId() {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function createMeeting({ title, source }) {
  const db = await ensureLoaded();
  const meeting = {
    id: newId(),
    title: title || 'Untitled meeting',
    source: source || 'live',        // 'live' | 'upload'
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationSec: 0,
    segments: [],                    // { speaker, text, ts }
    speakers: [],
    summary: null,                   // { summary, keyPoints, decisions, actionItems, topics }
    status: 'recording'              // 'recording' | 'done'
  };
  db.meetings.unshift(meeting);
  await persist();
  return meeting;
}

async function getMeeting(id) {
  const db = await ensureLoaded();
  return db.meetings.find((m) => m.id === id) || null;
}

async function updateMeeting(id, patch) {
  const db = await ensureLoaded();
  const meeting = db.meetings.find((m) => m.id === id);
  if (!meeting) return null;
  Object.assign(meeting, patch, { updatedAt: new Date().toISOString() });
  await persist();
  return meeting;
}

async function appendSegment(id, segment) {
  const db = await ensureLoaded();
  const meeting = db.meetings.find((m) => m.id === id);
  if (!meeting) return null;
  meeting.segments.push(segment);
  if (segment.speaker && !meeting.speakers.includes(segment.speaker)) {
    meeting.speakers.push(segment.speaker);
  }
  meeting.updatedAt = new Date().toISOString();
  await persist();
  return meeting;
}

async function deleteMeeting(id) {
  const db = await ensureLoaded();
  const before = db.meetings.length;
  db.meetings = db.meetings.filter((m) => m.id !== id);
  await persist();
  return db.meetings.length < before;
}

/**
 * listMeetings({ q }) — newest first. When `q` is given, does a simple
 * case-insensitive full-text match across title, summary, key points,
 * action items and the transcript itself.
 */
async function listMeetings({ q } = {}) {
  const db = await ensureLoaded();
  let list = db.meetings;

  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    list = list.filter((m) => haystack(m).includes(needle));
  }

  // Return lightweight records for the list view (no full transcript).
  return list.map((m) => ({
    id: m.id,
    title: m.title,
    source: m.source,
    createdAt: m.createdAt,
    durationSec: m.durationSec,
    speakers: m.speakers,
    status: m.status,
    segmentCount: m.segments.length,
    actionItemCount: m.summary && m.summary.actionItems ? m.summary.actionItems.length : 0,
    preview: m.summary && m.summary.summary ? m.summary.summary.slice(0, 160) : ''
  }));
}

function haystack(m) {
  const parts = [m.title || '', m.source || ''];
  if (m.summary) {
    parts.push(m.summary.summary || '');
    (m.summary.keyPoints || []).forEach((p) => parts.push(p));
    (m.summary.decisions || []).forEach((p) => parts.push(p));
    (m.summary.topics || []).forEach((p) => parts.push(p));
    (m.summary.actionItems || []).forEach((a) => {
      parts.push([a.task, a.owner, a.due].filter(Boolean).join(' '));
    });
  }
  m.segments.forEach((s) => parts.push(`${s.speaker || ''} ${s.text || ''}`));
  return parts.join(' \n ').toLowerCase();
}

module.exports = {
  createMeeting,
  getMeeting,
  updateMeeting,
  appendSegment,
  deleteMeeting,
  listMeetings
};
