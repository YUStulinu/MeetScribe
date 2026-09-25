/**
 * claude.js — talks to the Anthropic API to turn a transcript into a
 * structured meeting summary.
 *
 * Two modes:
 *   - 'live'  : a short rolling summary, refreshed while the meeting runs
 *   - 'final' : a fuller summary produced once the meeting ends
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TRANSCRIPT_CHARS = 40000;

function getConfig() {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
  };
}

function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Renders segments as "Speaker: text" lines. If the transcript is longer
 * than the cap, keeps the most recent portion — for a rolling summary the
 * tail is what matters most.
 */
function segmentsToText(segments) {
  const lines = (segments || []).map((s) => `${s.speaker || 'Speaker'}: ${s.text}`);
  let text = lines.join('\n');
  let truncated = false;
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(-MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }
  return { text, truncated };
}

function buildSystemPrompt(mode) {
  const isLive = mode === 'live';

  return `You summarize meeting transcripts into structured notes.
Respond STRICTLY with valid JSON (no extra text, no backticks, no markdown), matching exactly this structure:

{
  "title": "a short descriptive title for the meeting, a few words",
  "summary": "${isLive ? '2-3 sentences covering what has been discussed so far' : '4-7 sentences covering the whole meeting'}",
  "keyPoints": ["the most important points raised, one concise sentence each"],
  "decisions": ["decisions that were actually agreed on, one per entry"],
  "actionItems": [
    { "task": "what needs to be done", "owner": "who is responsible, or empty string if unclear", "due": "deadline if mentioned, otherwise empty string" }
  ],
  "topics": ["short topic labels, 1-3 words each"]
}

Include ${isLive ? '3-5' : '4-8'} keyPoints. Return empty arrays for decisions, actionItems or topics when the transcript contains none — do not invent them.
Only use what is actually in the transcript. Never invent names, numbers, dates or commitments.
The transcript comes from automatic speech recognition, so expect typos and broken words; interpret them sensibly but do not fabricate meaning where it is unclear.
Speaker labels may be generic (Speaker 1, Speaker 2). Use them for the "owner" field only when the transcript makes the assignment explicit.
Write the notes in the same language as the transcript.
${isLive ? 'This meeting is still in progress, so summarize what has happened up to this point without speculating about what comes next.' : 'This is the complete meeting.'}`;
}

/**
 * generateSummary(segments, mode) -> structured summary object
 * Throws an Error with .status set when something goes wrong.
 */
async function generateSummary(segments, mode = 'live') {
  const { apiKey, model } = getConfig();

  if (!apiKey) {
    const err = new Error('Missing ANTHROPIC_API_KEY. Add it to your .env file (see .env.example).');
    err.status = 500;
    throw err;
  }

  const { text, truncated } = segmentsToText(segments);
  if (!text.trim()) {
    const err = new Error('The transcript is empty — nothing to summarize yet.');
    err.status = 400;
    throw err;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: mode === 'live' ? 1200 : 2000,
      system: buildSystemPrompt(mode),
      messages: [{ role: 'user', content: `Meeting transcript:\n\n${text}` }]
    })
  });

  if (!res.ok) {
    const details = await res.text();
    console.error('Anthropic API error:', res.status, details);
    const err = new Error('Error calling the Anthropic API.');
    err.status = 502;
    err.details = details;
    throw err;
  }

  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === 'text');
  const raw = block ? block.text : '';
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('JSON parse error:', parseErr.message, 'Raw:', raw.slice(0, 500));
    const err = new Error('Could not parse the AI response as JSON.');
    err.status = 502;
    err.details = raw;
    throw err;
  }

  // Normalize so the frontend can rely on the shape.
  return {
    title: parsed.title || '',
    summary: parsed.summary || '',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map((a) => ({
          task: (a && a.task) || '',
          owner: (a && a.owner) || '',
          due: (a && a.due) || ''
        })).filter((a) => a.task)
      : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    mode,
    truncated,
    generatedAt: new Date().toISOString()
  };
}

module.exports = { generateSummary, hasApiKey };
