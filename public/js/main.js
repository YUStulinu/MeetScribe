/**
 * main.js — wires the UI together: tab switching, the live session,
 * file upload, the searchable library and the meeting detail view.
 */
import { LiveSession, isSpeechSupported } from './live.js';
import {
  escapeHtml, formatTime, formatDate, createSpeakerPalette,
  transcriptLine, summaryHtml, meetingCard, meetingAsText, downloadText
} from './render.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------- State ---------------- */
let session = null;
let colorFor = createSpeakerPalette();
let speakers = ['Speaker 1', 'Speaker 2'];
let activeSpeaker = 'Speaker 1';
let timerInterval = null;
let selectedFile = null;
let serverCapabilities = { anthropic: false, transcription: false };

/* ---------------- Tabs ---------------- */
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (session?.running && btn.dataset.tab !== 'record') {
      const ok = confirm('A recording is in progress. Leaving this tab keeps it running — continue?');
      if (!ok) return;
    }
    switchTab(btn.dataset.tab);
  });
});

function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === `tab-${name}`));
  $('#meetingDetail').hidden = true;
  if (name === 'library') loadLibrary();
}

/* ---------------- Startup checks ---------------- */
(async function init() {
  try {
    const res = await fetch('/api/health');
    serverCapabilities = await res.json();
  } catch {
    // Server unreachable; the UI still loads and errors surface on use.
  }

  if (!isSpeechSupported()) {
    const warn = $('#supportWarning');
    warn.textContent = 'This browser does not support live speech recognition. Chrome or Edge work best — or use the Upload tab instead.';
    warn.hidden = false;
    $('#startBtn').disabled = true;
  }

  if (!serverCapabilities.transcription) {
    const notice = $('#transcriptionNotice');
    notice.textContent = 'Audio transcription is not configured on this server (no OPENAI_API_KEY). You can still upload a .txt or .vtt transcript, or use live recording.';
    notice.hidden = false;
  }

  renderSpeakerButtons();
})();

/* ================================================================
 * LIVE RECORDING
 * ================================================================ */

$('#startBtn').addEventListener('click', startRecording);
$('#stopBtn').addEventListener('click', stopRecording);
$('#refreshSummaryBtn').addEventListener('click', () => {
  session?.requestSummary();
  setSummaryStatus('Refreshing…', true);
});
$('#addSpeakerBtn').addEventListener('click', addSpeaker);

async function startRecording() {
  const title = $('#meetingTitle').value.trim();
  const lang = $('#langSelect').value;

  session = new LiveSession();
  wireSessionEvents(session);

  try {
    $('#startBtn').disabled = true;
    await session.start({ title, lang });
  } catch (err) {
    alert(err.message);
    $('#startBtn').disabled = false;
    session = null;
    return;
  }

  // Reset the live view.
  colorFor = createSpeakerPalette();
  $('#transcriptList').innerHTML = '';
  $('#interimLine').textContent = '';
  $('#liveSummary').innerHTML = '<p class="placeholder">The summary appears once there\'s enough conversation to work with.</p>';
  $('#sessionTitle').textContent = title || 'Recording';
  setSummaryStatus('');

  $('#recordIdle').hidden = true;
  $('#recordActive').hidden = false;
  $('#recDot').classList.remove('is-paused');

  startTimer();
}

function wireSessionEvents(s) {
  s.addEventListener('started', (e) => {
    if (e.detail?.title) $('#sessionTitle').textContent = e.detail.title;
  });

  s.addEventListener('segment', (e) => {
    appendTranscriptLine(e.detail);
    $('#interimLine').textContent = '';
  });

  s.addEventListener('interim', (e) => {
    $('#interimLine').textContent = e.detail.text;
  });

  s.addEventListener('summary', (e) => {
    $('#liveSummary').innerHTML = summaryHtml(e.detail.summary);
    if (e.detail.title) $('#sessionTitle').textContent = e.detail.title;
    setSummaryStatus(`Updated ${new Date().toLocaleTimeString()}`);
  });

  s.addEventListener('summary-pending', () => setSummaryStatus('Writing…', true));
  s.addEventListener('summary-error', (e) => setSummaryStatus(e.detail.message));
  s.addEventListener('warning', (e) => setSummaryStatus(e.detail.message));
  s.addEventListener('mic-denied', () => finishSessionUI());

  s.addEventListener('stopped', (e) => {
    stopTimer();
    finishSessionUI();
    if (e.detail) openMeeting(e.detail.id);
  });
}

function appendTranscriptLine(segment) {
  const list = $('#transcriptList');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.appendChild(transcriptLine(segment, colorFor));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function stopRecording() {
  if (!session) return;
  $('#stopBtn').disabled = true;
  $('#recDot').classList.add('is-paused');
  setSummaryStatus('Writing the final summary…', true);
  session.stop();
  stopTimer();
}

function finishSessionUI() {
  $('#stopBtn').disabled = false;
  $('#startBtn').disabled = false;
  $('#recordActive').hidden = true;
  $('#recordIdle').hidden = false;
  $('#meetingTitle').value = '';
  session?.disconnect();
  session = null;
}

function setSummaryStatus(text, working = false) {
  const el = $('#summaryStatus');
  el.textContent = text;
  el.classList.toggle('is-working', working);
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (session) $('#sessionTimer').textContent = formatTime(session.elapsedSec());
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

/* ---------------- Speakers ---------------- */

function renderSpeakerButtons() {
  const wrap = $('#speakerButtons');
  wrap.innerHTML = '';
  speakers.forEach((name) => {
    const btn = document.createElement('button');
    btn.className = 'speaker-btn' + (name === activeSpeaker ? ' is-active' : '');
    btn.innerHTML = `<span class="sp-dot"></span>${escapeHtml(name)}`;
    btn.title = 'Click to mark as current speaker · double-click to rename';

    btn.addEventListener('click', () => {
      activeSpeaker = name;
      session?.setSpeaker(name);
      renderSpeakerButtons();
    });

    btn.addEventListener('dblclick', () => {
      const next = prompt('Rename this speaker:', name);
      if (!next || !next.trim()) return;
      const idx = speakers.indexOf(name);
      speakers[idx] = next.trim();
      if (activeSpeaker === name) {
        activeSpeaker = next.trim();
        session?.setSpeaker(activeSpeaker);
      }
      renderSpeakerButtons();
    });

    wrap.appendChild(btn);
  });
}

function addSpeaker() {
  const name = prompt('Name for the new speaker:', `Speaker ${speakers.length + 1}`);
  if (!name || !name.trim()) return;
  speakers.push(name.trim());
  renderSpeakerButtons();
}

// Number keys 1-9 switch speaker while recording.
document.addEventListener('keydown', (e) => {
  if (!session?.running) return;
  if (e.target.matches('input, textarea, select')) return;
  const n = Number(e.key);
  if (n >= 1 && n <= speakers.length) {
    activeSpeaker = speakers[n - 1];
    session.setSpeaker(activeSpeaker);
    renderSpeakerButtons();
  }
});

/* ================================================================
 * UPLOAD
 * ================================================================ */

const dropzone = $('#uploadDropzone');
const uploadInput = $('#uploadInput');

dropzone.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  if (uploadInput.files?.[0]) setSelectedFile(uploadInput.files[0]);
});
['dragover', 'dragenter'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('is-dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) setSelectedFile(file);
});

function setSelectedFile(file) {
  selectedFile = file;
  const mb = (file.size / 1024 / 1024).toFixed(1);
  $('#uploadFileName').textContent = `Selected: ${file.name} (${mb} MB)`;
}

$('#uploadBtn').addEventListener('click', async () => {
  const errEl = $('#uploadError');
  errEl.hidden = true;

  if (!selectedFile) {
    errEl.textContent = 'Choose an audio file or transcript first.';
    errEl.hidden = false;
    return;
  }

  const form = new FormData();
  form.append('file', selectedFile);
  form.append('diarize', $('#diarizeCb').checked ? 'true' : 'false');

  $('#uploadBtn').disabled = true;
  $('#uploadLoading').hidden = false;

  try {
    const res = await fetch('/api/meetings/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');

    if (data.summaryError) {
      alert('The transcript was saved, but the summary failed: ' + data.summaryError);
    }
    selectedFile = null;
    uploadInput.value = '';
    $('#uploadFileName').textContent = '';
    openMeeting(data.meeting.id);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    $('#uploadBtn').disabled = false;
    $('#uploadLoading').hidden = true;
  }
});

/* ================================================================
 * LIBRARY
 * ================================================================ */

let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => loadLibrary(q), 220);
});

async function loadLibrary(q = '') {
  const list = $('#meetingList');
  const empty = $('#libraryEmpty');

  try {
    const url = q ? `/api/meetings?q=${encodeURIComponent(q)}` : '/api/meetings';
    const res = await fetch(url);
    const data = await res.json();
    const meetings = data.meetings || [];

    list.innerHTML = '';
    if (!meetings.length) {
      empty.hidden = false;
      empty.querySelector('p').textContent = q
        ? `No meetings match "${q}".`
        : 'No meetings yet. Record one or upload a recording to get started.';
      return;
    }
    empty.hidden = true;

    meetings.forEach((m) => {
      const card = meetingCard(m);
      card.addEventListener('click', () => openMeeting(m.id));
      list.appendChild(card);
    });
  } catch (err) {
    empty.hidden = false;
    empty.querySelector('p').textContent = 'Could not load meetings: ' + err.message;
  }
}

/* ================================================================
 * MEETING DETAIL
 * ================================================================ */

$('#backBtn').addEventListener('click', () => {
  $('#meetingDetail').hidden = true;
  switchTab('library');
});

async function openMeeting(id) {
  try {
    const res = await fetch(`/api/meetings/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the meeting.');
    renderDetail(data.meeting);
  } catch (err) {
    alert(err.message);
  }
}

function renderDetail(meeting) {
  $$('.tab-panel').forEach((p) => p.classList.remove('is-active'));
  $('#meetingDetail').hidden = false;

  const palette = createSpeakerPalette();
  const meta = [
    formatDate(meeting.createdAt),
    meeting.durationSec ? formatTime(meeting.durationSec) : null,
    meeting.speakers?.length ? meeting.speakers.join(', ') : null,
    meeting.source === 'upload' ? 'Uploaded recording' : 'Live recording'
  ].filter(Boolean);

  const transcriptHtml = (meeting.segments || []).map((seg) => `
    <div class="t-line">
      <span class="t-speaker ${palette(seg.speaker)}">${escapeHtml(seg.speaker)}</span>
      <span class="t-text">${escapeHtml(seg.text)}</span>
      <span class="t-time">${formatTime(seg.ts)}</span>
    </div>
  `).join('');

  $('#detailBody').innerHTML = `
    <div class="detail-head">
      <input class="detail-title" id="detailTitle" value="${escapeHtml(meeting.title)}" />
      <div class="detail-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>
    </div>

    <div class="detail-grid">
      <section class="transcript-pane">
        <h2 class="pane-title">Transcript</h2>
        <div class="transcript-list">${transcriptHtml || '<p class="placeholder">No transcript recorded.</p>'}</div>
      </section>

      <aside class="summary-pane">
        <h2 class="pane-title">Notes</h2>
        <div class="summary-body">${summaryHtml(meeting.summary)}</div>
        <div class="detail-actions">
          <button class="btn-outline" id="copyBtn">Copy notes</button>
          <button class="btn-outline" id="downloadBtn">Download .txt</button>
          <button class="btn-outline danger" id="deleteBtn">Delete</button>
        </div>
      </aside>
    </div>
  `;

  // Rename on blur / Enter.
  const titleInput = $('#detailTitle');
  const saveTitle = async () => {
    const next = titleInput.value.trim();
    if (!next || next === meeting.title) return;
    await fetch(`/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next })
    });
    meeting.title = next;
  };
  titleInput.addEventListener('blur', saveTitle);
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });

  $('#copyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(meetingAsText(meeting)).catch(() => {});
  });

  $('#downloadBtn').addEventListener('click', () => {
    downloadText(meetingAsText(meeting), `${meeting.title}.txt`);
  });

  $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this meeting permanently?')) return;
    await fetch(`/api/meetings/${meeting.id}`, { method: 'DELETE' });
    $('#meetingDetail').hidden = true;
    switchTab('library');
  });
}

// Warn before closing the tab mid-recording.
window.addEventListener('beforeunload', (e) => {
  if (session?.running) {
    e.preventDefault();
    e.returnValue = '';
  }
});
