/**
 * transcribe.js — converts an uploaded audio file into speaker-labeled segments.
 *
 * Uses OpenAI's transcription endpoint. Two models are relevant:
 *   - gpt-4o-transcribe-diarize : returns segments tagged with a speaker
 *   - gpt-transcribe            : plain transcription, no speaker labels
 *
 * This module is optional: without OPENAI_API_KEY the app still works fully
 * in live mode, and users can paste or upload a text transcript instead.
 */
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

// The transcription endpoint rejects anything over 25 MB.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const AUDIO_EXTENSIONS = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm'];

function hasApiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function isAudioFile(filename, mimetype) {
  const lower = (filename || '').toLowerCase();
  if (AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return Boolean(mimetype && (mimetype.startsWith('audio/') || mimetype === 'video/mp4'));
}

/**
 * transcribeAudio(buffer, filename, { diarize })
 * -> { segments: [{ speaker, text, ts }], model }
 *
 * `ts` is seconds from the start of the recording, so the UI can show
 * timestamps next to each line.
 */
async function transcribeAudio(buffer, filename, { diarize = true } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const err = new Error(
      'Audio transcription needs OPENAI_API_KEY in your .env file. ' +
      'Without it you can still use live recording, or upload a .txt transcript.'
    );
    err.status = 400;
    throw err;
  }

  if (buffer.length > MAX_AUDIO_BYTES) {
    const err = new Error(
      `Audio file is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). ` +
      'The limit is 25 MB — compress it or split it into shorter parts.'
    );
    err.status = 413;
    throw err;
  }

  const model = diarize
    ? (process.env.OPENAI_DIARIZE_MODEL || 'gpt-4o-transcribe-diarize')
    : (process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe');

  const form = new FormData();
  form.append('file', new Blob([buffer]), filename || 'audio.webm');
  form.append('model', model);

  if (diarize) {
    // diarized_json is what carries the per-speaker segments.
    form.append('response_format', 'diarized_json');
    // Required for recordings longer than 30 seconds.
    form.append('chunking_strategy', 'auto');
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok) {
    const details = await res.text();
    console.error('OpenAI transcription error:', res.status, details);
    const err = new Error('Error calling the transcription API.');
    err.status = 502;
    err.details = details;
    throw err;
  }

  const data = await res.json();

  // Diarized responses carry a segments array; plain ones only carry text.
  if (Array.isArray(data.segments) && data.segments.length) {
    const labeller = createSpeakerLabeller();
    const segments = data.segments
      .filter((s) => s && s.text && s.text.trim())
      .map((s) => ({
        speaker: labeller(s.speaker),
        text: s.text.trim(),
        ts: typeof s.start === 'number' ? Math.round(s.start) : 0
      }));
    if (segments.length) return { segments, model };
  }

  if (data.text && data.text.trim()) {
    return {
      segments: [{ speaker: 'Speaker 1', text: data.text.trim(), ts: 0 }],
      model
    };
  }

  const err = new Error('The transcription came back empty. The audio may be silent or unsupported.');
  err.status = 502;
  throw err;
}

/**
 * The API labels speakers however it likes — "A"/"B", "speaker_0",
 * "speaker_1" — and different models use different conventions, some
 * 0-indexed and some 1-indexed. Rather than guessing the convention,
 * this assigns "Speaker 1", "Speaker 2", ... in order of first appearance,
 * which is deterministic and always reads correctly.
 *
 * Anything that looks like a real name (from known_speaker_names) is kept
 * as-is instead of being renumbered.
 */
function createSpeakerLabeller() {
  const seen = new Map();

  return function label(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return 'Speaker 1';
    }
    const key = String(raw).trim();

    // Generic machine labels: A, B, 0, 1, speaker_0, speaker 2, ...
    const isGeneric = /^[A-Za-z]$/.test(key) || /^(?:speaker[\s_-]*)?\d+$/i.test(key);
    if (!isGeneric) return key; // a real name — leave it alone

    if (!seen.has(key)) seen.set(key, seen.size + 1);
    return `Speaker ${seen.get(key)}`;
  };
}

/**
 * Parses a plain-text or WebVTT/SRT transcript into segments, so the app
 * is useful even with no transcription API key at all.
 */
function parseTextTranscript(text) {
  const clean = String(text || '').replace(/\r/g, '');
  const lines = clean.split('\n');
  const segments = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip WebVTT/SRT scaffolding: "WEBVTT", cue numbers, timing lines.
    if (/^WEBVTT/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/-->/.test(trimmed)) continue;

    // "Name: what they said"
    const match = trimmed.match(/^([A-Za-zÀ-ž0-9 ._-]{1,40}):\s*(.+)$/);
    if (match) {
      segments.push({ speaker: match[1].trim(), text: match[2].trim(), ts: 0 });
    } else if (segments.length) {
      // Continuation of the previous speaker's line.
      segments[segments.length - 1].text += ' ' + trimmed;
    } else {
      segments.push({ speaker: 'Speaker 1', text: trimmed, ts: 0 });
    }
  }

  return segments;
}

module.exports = {
  transcribeAudio,
  parseTextTranscript,
  isAudioFile,
  hasApiKey,
  MAX_AUDIO_BYTES
};
