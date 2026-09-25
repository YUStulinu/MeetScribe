/**
 * live.js — the live recording session.
 *
 * Two moving parts:
 *   1. SpeechRecognition (browser-native speech-to-text). It hands back
 *      interim guesses and, once it's confident, final chunks of text.
 *   2. A WebSocket to the server, which stores those final chunks and
 *      pushes back refreshed summaries.
 *
 * The fiddly bit is that SpeechRecognition stops on its own — after a
 * pause, after a timeout, or on a transient network hiccup. So we restart
 * it automatically for as long as the user hasn't pressed Stop.
 */

export function isSpeechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class LiveSession extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.recognition = null;
    this.meetingId = null;
    this.startedAt = null;
    this.running = false;
    this.currentSpeaker = 'Speaker 1';
    this.lang = 'en-US';
    this._restartTimer = null;
    this._shouldRestart = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  elapsedSec() {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /* ---------------- WebSocket ---------------- */

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}/ws`);

      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('Could not connect to the server.')));

      this.ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this.handleServerMessage(msg);
      });

      this.ws.addEventListener('close', () => {
        if (this.running) {
          this.emit('warning', { message: 'Connection to the server was lost.' });
        }
      });
    });
  }

  handleServerMessage(msg) {
    switch (msg.type) {
      case 'session:started':
      case 'session:joined':
        this.meetingId = msg.meeting.id;
        this.emit('started', msg.meeting);
        break;
      case 'segment':
        // A segment from another client watching the same meeting.
        this.emit('segment', msg.segment);
        break;
      case 'summary':
        this.emit('summary', { summary: msg.summary, title: msg.title });
        break;
      case 'summary:pending':
        this.emit('summary-pending');
        break;
      case 'summary:error':
        this.emit('summary-error', { message: msg.message });
        break;
      case 'session:stopped':
        this.emit('stopped', msg.meeting);
        break;
      case 'error':
        this.emit('warning', { message: msg.message });
        break;
    }
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /* ---------------- Speech recognition ---------------- */

  buildRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;

    rec.addEventListener('result', (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;

        if (result.isFinal) {
          const segment = {
            speaker: this.currentSpeaker,
            text,
            ts: this.elapsedSec()
          };
          this.emit('segment', segment);
          this.send({ type: 'segment', ...segment });
        } else {
          interim += text + ' ';
        }
      }
      this.emit('interim', { text: interim.trim() });
    });

    rec.addEventListener('error', (event) => {
      // 'no-speech' and 'aborted' are routine; just let the restart happen.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this._shouldRestart = false;
        this.emit('warning', {
          message: 'Microphone access was blocked. Allow it in your browser settings and start again.'
        });
        this.emit('mic-denied');
      } else if (event.error === 'audio-capture') {
        this._shouldRestart = false;
        this.emit('warning', { message: 'No microphone was found.' });
      } else if (event.error === 'network') {
        this.emit('warning', { message: 'Speech recognition lost network access — retrying.' });
      }
    });

    rec.addEventListener('end', () => {
      // Chrome ends the session regularly; restart unless the user stopped.
      if (this._shouldRestart && this.running) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          try {
            rec.start();
          } catch {
            // start() throws if it's somehow already running; harmless.
          }
        }, 250);
      }
    });

    return rec;
  }

  /* ---------------- Public controls ---------------- */

  async start({ title, lang }) {
    if (!isSpeechSupported()) {
      throw new Error('This browser has no speech recognition. Use Chrome or Edge, or upload a recording instead.');
    }

    this.lang = lang || 'en-US';
    await this.connect();
    this.send({ type: 'session:start', title });

    this.startedAt = Date.now();
    this.running = true;
    this._shouldRestart = true;

    this.recognition = this.buildRecognition();
    try {
      this.recognition.start();
    } catch (err) {
      throw new Error('Could not start the microphone: ' + err.message);
    }
  }

  setSpeaker(name) {
    this.currentSpeaker = name;
  }

  requestSummary() {
    this.send({ type: 'summary:request' });
  }

  stop() {
    this.running = false;
    this._shouldRestart = false;
    clearTimeout(this._restartTimer);

    if (this.recognition) {
      try { this.recognition.stop(); } catch { /* already stopped */ }
    }
    this.send({ type: 'session:stop', meetingId: this.meetingId });
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }
}
