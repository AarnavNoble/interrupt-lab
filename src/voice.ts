// Bot voice adapters. Both turn "speak this sentence" into TTS_PROGRESS and TTS_END events.
import type { Event, Unstamped } from './machine';

type Send = (event: Unstamped<Event>) => void;

export interface Voice {
  speak(turnId: number, index: number, text: string): void;
  stop(): void;
}

export const canSpeakAloud = typeof window !== 'undefined' && 'speechSynthesis' in window;

// The real browser voice. Progress comes from word boundary events, which some
// voices never send. Then the partial sentence counts as unheard, which is the safe side.
export function createBrowserVoice(send: Send): Voice {
  const synth = window.speechSynthesis;
  return {
    speak(turnId, index, text) {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(synth.getVoices());
      if (voice) utterance.voice = voice;
      utterance.onboundary = (e) => {
        if (e.name !== 'word') return;
        const wordLength = e.charLength || text.slice(e.charIndex).search(/\s|$/);
        send({ type: 'TTS_PROGRESS', turnId, index, chars: e.charIndex + wordLength });
      };
      // Chrome reports a cancelled utterance as an error. The reducer drops it as stale.
      utterance.onend = () => send({ type: 'TTS_END', turnId, index });
      utterance.onerror = () => send({ type: 'TTS_END', turnId, index });
      synth.speak(utterance);
    },
    stop() {
      synth.cancel();
    },
  };
}

// Local voices send word boundaries reliably; network voices often do not.
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((v) => v.lang.startsWith('en'));
  return english.find((v) => v.localService) ?? english[0];
}

// A silent voice that "reads" at a fixed speed. Used when speaking aloud is off or
// unsupported, and it makes the scripted scenarios behave the same on every machine.
const MS_PER_CHAR = 65;

export function createSilentVoice(send: Send): Voice {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    speak(turnId, index, text) {
      clearTimeout(timer);
      const words = [...text.matchAll(/\S+/g)];
      let next = 0;
      const step = () => {
        if (next === words.length) {
          send({ type: 'TTS_END', turnId, index });
          return;
        }
        const word = words[next++];
        send({ type: 'TTS_PROGRESS', turnId, index, chars: word.index! + word[0].length });
        timer = setTimeout(step, (word[0].length + 1) * MS_PER_CHAR);
      };
      step();
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
