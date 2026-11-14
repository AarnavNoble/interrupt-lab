// Bot voice adapters. Both turn "speak this sentence" into TTS_PROGRESS and TTS_END events.
import type { Event, Unstamped } from './machine';

type Send = (event: Unstamped<Event>) => void;

export interface Voice {
  speak(turnId: number, index: number, text: string): void;
  stop(): void;
}

export const canSpeakAloud = typeof window !== 'undefined' && !!window.speechSynthesis;

// The real browser voice. Progress comes from word boundary events, which some
// voices never send. Then the partial sentence counts as unheard, which is the safe side.
export function createBrowserVoice(send: Send): Voice {
  const synth = window.speechSynthesis;
  // Chrome can garbage collect a speaking utterance and never fire onend, so hold on to it.
  const playing = new Set<SpeechSynthesisUtterance>();
  return {
    speak(turnId, index, text) {
      const utterance = new SpeechSynthesisUtterance(text);
      playing.add(utterance);
      const voice = pickVoice(synth.getVoices());
      if (voice) utterance.voice = voice;
      utterance.onboundary = (e) => {
        if (e.name !== 'word') return;
        // A boundary fires as a word starts, so everything before it has been heard.
        send({ type: 'TTS_PROGRESS', turnId, index, chars: e.charIndex });
      };
      const finished = () => {
        playing.delete(utterance);
        send({ type: 'TTS_END', turnId, index });
      };
      utterance.onend = finished;
      // Chrome reports a cancelled utterance as an error, which the reducer drops as stale.
      // Known gap: a real synthesis failure also lands here and counts the sentence as heard.
      utterance.onerror = finished;
      synth.speak(utterance);
    },
    stop() {
      synth.cancel();
      playing.clear();
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
        send({ type: 'TTS_PROGRESS', turnId, index, chars: word.index! }); // same rule as the browser voice
        timer = setTimeout(step, (word[0].length + 1) * MS_PER_CHAR);
      };
      step();
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
