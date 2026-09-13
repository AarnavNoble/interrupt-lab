// Microphone adapter. Turns browser speech recognition callbacks into
// USER_SPEECH_START, USER_TRANSCRIPT and USER_SPEECH_END events.
import type { Event, Unstamped } from './machine';

type Send = (event: Unstamped<Event>) => void;

// The Web Speech recognition API is not in TypeScript's DOM types, so describe the parts we use.
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onspeechstart: (() => void) | null;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionConstructor = new () => Recognition;

const w = typeof window !== 'undefined' ? (window as unknown as Record<string, RecognitionConstructor | undefined>) : {};
const Recognizer = w.SpeechRecognition ?? w.webkitSpeechRecognition;

export const micSupported = Recognizer !== undefined;

export interface Mic {
  start(): void;
  stop(): void;
}

export function createMic(send: Send, onBlocked: (message: string) => void): Mic {
  let listening = false;
  let inSpeech = false;
  let recognition: Recognition | undefined;

  // Guards make start and end fire once per utterance, whatever order the browser uses.
  const speechStarted = () => {
    if (inSpeech) return;
    inSpeech = true;
    send({ type: 'USER_SPEECH_START' });
  };
  const speechEnded = () => {
    if (!inSpeech) return;
    inSpeech = false;
    send({ type: 'USER_SPEECH_END' });
  };

  // One recognition session per utterance. In continuous mode Chrome fires
  // speechstart only once per session, which would hide every later start time.
  const listen = () => {
    const r = new Recognizer!();
    r.continuous = false;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onspeechstart = speechStarted;
    r.onresult = (e) => {
      speechStarted(); // in case a result beats the speechstart callback
      const results = Array.from(e.results);
      send({ type: 'USER_TRANSCRIPT', text: results.map((res) => res[0].transcript).join('') });
      if (results.at(-1)?.isFinal) speechEnded();
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false;
        onBlocked('Microphone blocked. Open the app in its own tab and allow mic access.');
      }
    };
    r.onend = () => {
      speechEnded();
      if (listening) listen();
    };
    recognition = r;
    r.start();
  };

  return {
    start() {
      if (!Recognizer || listening) return;
      listening = true;
      listen();
    },
    stop() {
      listening = false;
      recognition?.abort();
      speechEnded();
    },
  };
}
