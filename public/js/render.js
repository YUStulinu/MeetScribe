/**
 * render.js — pure rendering helpers. No network, no state; these take
 * data and produce DOM or HTML strings.
 */

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/** Stable color class per speaker, based on order of first appearance. */
export function createSpeakerPalette() {
  const map = new Map();
  return (speaker) => {
    if (!map.has(speaker)) map.set(speaker, map.size % 5);
    return `sp-${map.get(speaker)}`;
  };
}

/** One transcript line. */
export function transcriptLine(segment, colorFor, showTime = true) {
  const el = document.createElement('div');
  el.className = 't-line';
  el.innerHTML = `
    <span class="t-speaker ${colorFor(segment.speaker)}">${escapeHtml(segment.speaker)}</span>
    <span class="t-text">${escapeHtml(segment.text)}</span>
    ${showTime ? `<span class="t-time">${formatTime(segment.ts)}</span>` : ''}
  `;
  return el;
}

/** The structured summary block (shared by live view and detail view). */
export function summaryHtml(summary) {
  if (!summary) {
    return '<p class="placeholder">No summary available for this meeting.</p>';
  }

  const parts = [];

  if (summary.summary) {
    parts.push(`
      <div class="summary-section">
        <h3>Summary</h3>
        <p class="summary-text">${escapeHtml(summary.summary)}</p>
      </div>
    `);
  }

  if (summary.keyPoints?.length) {
    parts.push(`
      <div class="summary-section">
        <h3>Key points</h3>
        <ul class="bullet-list">
          ${summary.keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}
        </ul>
      </div>
    `);
  }

  if (summary.decisions?.length) {
    parts.push(`
      <div class="summary-section">
        <h3>Decisions</h3>
        <ul class="bullet-list decision-list">
          ${summary.decisions.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}
        </ul>
      </div>
    `);
  }

  if (summary.actionItems?.length) {
    parts.push(`
      <div class="summary-section">
        <h3>Action items</h3>
        <ul class="action-list">
          ${summary.actionItems.map((a) => {
            const meta = [a.owner, a.due].filter(Boolean).join(' · ');
            return `
              <li class="action-item">
                <span class="a-check">☐</span>
                <span>
                  <span class="action-task">${escapeHtml(a.task)}</span>
                  ${meta ? `<div class="action-meta">${escapeHtml(meta)}</div>` : ''}
                </span>
              </li>`;
          }).join('')}
        </ul>
      </div>
    `);
  }

  if (summary.topics?.length) {
    parts.push(`
      <div class="summary-section">
        <h3>Topics</h3>
        <div class="topic-chips">
          ${summary.topics.map((t) => `<span class="topic-chip">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
    `);
  }

  if (summary.truncated) {
    parts.push('<p class="hint">Note: the transcript was long, so only the most recent portion was summarized.</p>');
  }

  return parts.join('') || '<p class="placeholder">Nothing substantial to summarize yet.</p>';
}

/** A single card in the library list. */
export function meetingCard(meeting) {
  const li = document.createElement('li');
  li.className = 'meeting-card';
  li.dataset.id = meeting.id;

  const badge = meeting.status === 'recording'
    ? '<span class="mc-badge live">Recording</span>'
    : `<span class="mc-badge">${meeting.source === 'upload' ? 'Uploaded' : 'Recorded'}</span>`;

  const meta = [
    formatDate(meeting.createdAt),
    meeting.durationSec ? formatTime(meeting.durationSec) : null,
    meeting.speakers?.length ? `${meeting.speakers.length} speaker${meeting.speakers.length > 1 ? 's' : ''}` : null,
    meeting.actionItemCount ? `${meeting.actionItemCount} action item${meeting.actionItemCount > 1 ? 's' : ''}` : null
  ].filter(Boolean);

  li.innerHTML = `
    <div class="mc-main">
      <p class="mc-title">${escapeHtml(meeting.title)}</p>
      ${meeting.preview ? `<p class="mc-preview">${escapeHtml(meeting.preview)}…</p>` : ''}
      <div class="mc-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>
    </div>
    <div class="mc-actions">${badge}</div>
  `;
  return li;
}

/** Plain-text export of a meeting, for download / copy. */
export function meetingAsText(meeting) {
  const lines = [meeting.title, `Date: ${formatDate(meeting.createdAt)}`, ''];
  const s = meeting.summary;

  if (s) {
    if (s.summary) lines.push('SUMMARY', s.summary, '');
    if (s.keyPoints?.length) {
      lines.push('KEY POINTS');
      s.keyPoints.forEach((p) => lines.push(`- ${p}`));
      lines.push('');
    }
    if (s.decisions?.length) {
      lines.push('DECISIONS');
      s.decisions.forEach((d) => lines.push(`- ${d}`));
      lines.push('');
    }
    if (s.actionItems?.length) {
      lines.push('ACTION ITEMS');
      s.actionItems.forEach((a) => {
        const meta = [a.owner, a.due].filter(Boolean).join(', ');
        lines.push(`- [ ] ${a.task}${meta ? ` (${meta})` : ''}`);
      });
      lines.push('');
    }
  }

  lines.push('TRANSCRIPT');
  (meeting.segments || []).forEach((seg) => {
    lines.push(`[${formatTime(seg.ts)}] ${seg.speaker}: ${seg.text}`);
  });

  return lines.join('\n');
}

export function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^a-z0-9.\-_ ]/gi, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
