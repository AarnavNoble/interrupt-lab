// Canned conversations that fake the user's side on a timer, so the whole machine
// can be demoed without a microphone. The bot side (replies, voice, noise gate) runs for real.
import type { Event, Unstamped } from './machine';

type Send = (event: Unstamped<Event>) => void;

export interface Scenario {
  name: string;
  about: string;
  steps: [ms: number, event: Unstamped<Event>][]; // ms after the conversation starts
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'Interrupt mid-sentence',
    about: 'You say "wait" during the second sentence. The first word arrives before the noise gate and is buffered, not lost.',
    steps: [
      [3600, { type: 'USER_SPEECH_START' }],
      [3750, { type: 'USER_TRANSCRIPT', text: 'wait' }],
      [4400, { type: 'USER_TRANSCRIPT', text: 'wait, tell me a joke' }],
      [4700, { type: 'USER_SPEECH_END' }],
    ],
  },
  {
    name: 'Double interrupt',
    about: 'You type "stop", then start talking before the reply arrives. One user turn, one reply, stale chunks dropped. Then you ask what it said.',
    steps: [
      [3000, { type: 'USER_TYPED', text: 'stop' }],
      [3250, { type: 'USER_SPEECH_START' }],
      [3500, { type: 'USER_TRANSCRIPT', text: 'actually tell me a story' }],
      [3900, { type: 'USER_SPEECH_END' }],
      [8000, { type: 'USER_SPEECH_START' }],
      [8150, { type: 'USER_TRANSCRIPT', text: 'what did you just say' }],
      [8800, { type: 'USER_SPEECH_END' }],
    ],
  },
  {
    name: 'Noise blip',
    about: 'A 150ms click, then 600ms of sound with no words. Neither passes the noise gate, so the bot keeps talking.',
    steps: [
      [2600, { type: 'USER_SPEECH_START' }],
      [2750, { type: 'USER_SPEECH_END' }],
      [5000, { type: 'USER_SPEECH_START' }],
      [5100, { type: 'USER_TRANSCRIPT', text: '' }],
      [5600, { type: 'USER_SPEECH_END' }],
    ],
  },
  {
    name: 'No interrupt',
    about: 'Nobody cuts in. The opener streams, plays every sentence, and the machine returns to idle.',
    steps: [],
  },
];

// Starts a fresh conversation and schedules the fake user events. Returns a cancel function.
export function playScenario(scenario: Scenario, send: Send): () => void {
  send({ type: 'RESET' });
  send({ type: 'START' });
  const timers = scenario.steps.map(([ms, event]) => setTimeout(() => send(event), ms));
  return () => timers.forEach(clearTimeout);
}
