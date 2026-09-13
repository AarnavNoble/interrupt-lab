// A tiny rule based "LLM". Deterministic, no network. It streams its reply one
// sentence at a time so the rest of the app behaves as if tokens were arriving.
import type { Event, Message, Unstamped } from './machine';

type Send = (event: Unstamped<Event>) => void;

const OPENER = [
  "Hi, I'm the Interrupt Lab bot.",
  'I talk in short streamed sentences, the way a voice agent reads a language model reply out loud.',
  'You can cut me off at any point by speaking, or by typing below and pressing Interrupt.',
  'When you do, I stop right away and only remember the words you actually heard.',
];

export function respond(userText: string | null, history: Message[]): string[] {
  if (userText === null) return OPENER;
  const text = userText.toLowerCase();

  if (/what did you (just )?say|repeat|say that again|last thing/.test(text)) {
    // The history ends with this user turn, so the bot message before it is what they heard last.
    const heard = history.filter((m) => m.role === 'bot').at(-1);
    if (!heard) return ["You haven't heard me say anything yet."];
    return [`The last thing you heard me say was: "${heard.text}"`, 'Anything I did not get to say was never counted.'];
  }
  if (text.includes('story')) {
    return [
      'Once there was a voice agent that could not stop talking.',
      'Every time someone tried to cut in, it started its greeting over from the top.',
      'Its engineers drew the whole conversation as a state machine and wrote a test for every strange ordering.',
      'After that it listened, stopped when it was interrupted, and never said hello twice.',
    ];
  }
  if (text.includes('joke')) {
    return ['Why did the voice bot cross the road?', 'It was interrupted before it could tell you.'];
  }
  if (text.includes('weather')) {
    return [
      'I have no internet access, so I cannot check the weather.',
      'I can tell you it is always sunny inside a pure function.',
      'No side effects, no clouds.',
    ];
  }
  if (/\b(stop|wait|hold on|pause)\b/.test(text)) {
    return ['Okay, I stopped.', 'What would you like to talk about?'];
  }
  return [
    `You said: "${userText}".`,
    'I am a small rule based bot, so I cannot really answer that.',
    'Try asking me for a story, a joke, the weather, or what I just said.',
  ];
}

const FIRST_CHUNK_MS = 500;
const NEXT_CHUNK_MS = 350;

// Pretend to stream. Cancelled replies are not stopped here on purpose: their late
// chunks carry an old turnId and the reducer drops them, the same way it would for a real network stream.
export function streamReply(turnId: number, sentences: string[], send: Send): void {
  sentences.forEach((text, i) => {
    setTimeout(() => send({ type: 'BOT_CHUNK', turnId, text }), FIRST_CHUNK_MS + i * NEXT_CHUNK_MS);
  });
  setTimeout(() => send({ type: 'BOT_DONE', turnId }), FIRST_CHUNK_MS + sentences.length * NEXT_CHUNK_MS);
}
