import { describe, expect, it } from 'vitest';
import {
  BotTurn,
  Effect,
  Event,
  NOISE_GATE_MS,
  State,
  UserTurn,
  deliveredText,
  initialState,
  reduce,
  undeliveredText,
} from './machine';

// Feed events through the reducer and keep everything it produced.
function run(events: Event[], start: State = initialState()) {
  let state = start;
  const effects: Effect[] = [];
  const transitions: string[] = [];
  for (const event of events) {
    const result = reduce(state, event);
    state = result.state;
    effects.push(...result.effects);
    transitions.push(result.transition);
  }
  return { state, effects, transitions };
}

const bots = (s: State) => s.turns.filter((t): t is BotTurn => t.kind === 'bot');
const users = (s: State) => s.turns.filter((t): t is UserTurn => t.kind === 'user');

// A conversation where the opener (turn 1) is streaming its two sentences
// and the voice has played the first 21 characters of the second one.
function botMidSecondSentence() {
  return run([
    { type: 'START', at: 0 },
    { type: 'BOT_CHUNK', at: 100, turnId: 1, text: 'Hi, I am the bot.' },
    { type: 'BOT_CHUNK', at: 200, turnId: 1, text: 'Here is a long second sentence.' },
    { type: 'BOT_DONE', at: 300, turnId: 1 },
    { type: 'TTS_END', at: 1500, turnId: 1, index: 0 },
    { type: 'TTS_PROGRESS', at: 2000, turnId: 1, index: 1, chars: 21 },
  ]);
}

describe('happy path', () => {
  it('speaks the opener sentence by sentence and returns to idle', () => {
    const { state, effects, transitions } = run([
      { type: 'START', at: 0 },
      { type: 'BOT_CHUNK', at: 100, turnId: 1, text: 'One.' },
      { type: 'BOT_CHUNK', at: 150, turnId: 1, text: 'Two.' },
      { type: 'TTS_END', at: 800, turnId: 1, index: 0 },
      { type: 'BOT_DONE', at: 900, turnId: 1 },
      { type: 'TTS_END', at: 1500, turnId: 1, index: 1 },
    ]);
    expect(state.phase).toBe('idle');
    expect(transitions).toEqual([
      'opener_requested',
      'reply_started',
      'chunk_queued',
      'next_sentence',
      'stream_done',
      'bot_turn_complete',
    ]);
    expect(effects.map((e) => e.type)).toEqual(['generate', 'speak', 'speak']);
    expect(bots(state)[0].status).toBe('done');
  });

  it('speaks a chunk that arrives after the voice caught up with the stream', () => {
    const { state, effects } = run([
      { type: 'START', at: 0 },
      { type: 'BOT_CHUNK', at: 100, turnId: 1, text: 'One.' },
      { type: 'TTS_END', at: 800, turnId: 1, index: 0 },
      { type: 'BOT_CHUNK', at: 900, turnId: 1, text: 'Two.' },
    ]);
    expect(state.phase).toBe('bot_speaking');
    expect(effects.at(-1)).toEqual({ type: 'speak', turnId: 1, index: 1, text: 'Two.' });
  });

  it('never touches the state it was given', () => {
    const before = botMidSecondSentence().state;
    const snapshot = structuredClone(before);
    reduce(before, { type: 'USER_TYPED', at: 2100, text: 'stop' });
    expect(before).toEqual(snapshot);
  });
});

describe('edge case: speech during the bot to user handoff is buffered', () => {
  it('keeps words heard during overlap as the start of the user turn', () => {
    const { state } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2150, text: 'wait' }, // before the gate: bot still talking
        { type: 'NOISE_GATE_ELAPSED', at: 2300, speechStartedAt: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2800, text: 'wait tell me a joke' },
        { type: 'USER_SPEECH_END', at: 3000 },
      ],
      botMidSecondSentence().state,
    );
    expect(users(state)[0].text).toBe('wait tell me a joke');
  });

  it('interrupts on the gate using text that was buffered before it', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2150, text: 'wait' },
        { type: 'NOISE_GATE_ELAPSED', at: 2300, speechStartedAt: 2000 },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions).toEqual(['overlap_began', 'overlap_text_buffered', 'interrupt_confirmed']);
    expect(state.phase).toBe('user_speaking');
    expect(state.utterance?.text).toBe('wait');
  });

  it('keeps the words if the bot finishes its reply while the user is overlapping', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2100, text: 'so' },
        { type: 'TTS_END', at: 2200, turnId: 1, index: 1 },
        { type: 'USER_TRANSCRIPT', at: 2600, text: 'so about that' },
        { type: 'USER_SPEECH_END', at: 2900 },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions[2]).toBe('bot_finished_during_overlap');
    expect(bots(state)[0].status).toBe('done');
    expect(users(state)[0].text).toBe('so about that');
  });
});

describe('edge case: the truncated bot turn stores delivered text only', () => {
  const interrupted = () =>
    run(
      [
        { type: 'USER_TYPED', at: 2100, text: 'stop' },
        { type: 'TTS_END', at: 2120, turnId: 1, index: 1 }, // cancel() fires a late end event
        { type: 'TTS_PROGRESS', at: 2130, turnId: 1, index: 1, chars: 31 },
      ],
      botMidSecondSentence().state,
    );

  it('splits the turn at what the voice actually played', () => {
    const bot = bots(interrupted().state)[0];
    expect(bot.status).toBe('interrupted');
    expect(deliveredText(bot)).toBe('Hi, I am the bot. Here is a long second');
    expect(undeliveredText(bot)).toBe('sentence.');
  });

  it('ignores late voice events from the cancelled sentence', () => {
    expect(interrupted().transitions.slice(1)).toEqual(['stale_tts_dropped', 'stale_tts_dropped']);
  });

  it('sends only delivered text to the responder', () => {
    const generate = interrupted().effects.find((e) => e.type === 'generate' && e.userText === 'stop');
    expect(generate).toEqual({
      type: 'generate',
      turnId: 3,
      userText: 'stop',
      history: [
        { role: 'bot', text: 'Hi, I am the bot. Here is a long second' },
        { role: 'user', text: 'stop' },
      ],
    });
  });

  it('stops the voice exactly once', () => {
    expect(interrupted().effects.filter((e) => e.type === 'stopSpeaking')).toHaveLength(1);
  });
});

describe('edge case: the opener is never replayed', () => {
  it('replies to the interrupt instead of re-requesting the unfinished opener', () => {
    const { state, effects, transitions } = run(
      [
        { type: 'USER_TYPED', at: 2100, text: 'hello' },
        { type: 'BOT_CHUNK', at: 2150, turnId: 1, text: 'A late opener chunk.' },
        { type: 'START', at: 2200 }, // a second click on Start
      ],
      botMidSecondSentence().state,
    );
    expect(transitions.slice(1)).toEqual(['stale_chunk_dropped', 'start_ignored_already_started']);
    expect(effects.filter((e) => e.type === 'generate' && e.userText === null)).toHaveLength(0);
    expect(effects.filter((e) => e.type === 'speak')).toHaveLength(0);
    expect(state.awaitingReplyId).toBe(3);
  });

  it('does not greet later if the user spoke before pressing Start', () => {
    const { effects, transitions } = run([
      { type: 'USER_TYPED', at: 0, text: 'hi' },
      { type: 'START', at: 100 },
    ]);
    expect(transitions).toEqual(['typed_turn', 'start_ignored_already_started']);
    expect(effects.filter((e) => e.type === 'generate')).toHaveLength(1);
  });
});

describe('edge case: interrupt time comes from speech start', () => {
  it('uses USER_SPEECH_START for the user turn, not when recognition finished', () => {
    const { state } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'NOISE_GATE_ELAPSED', at: 2300, speechStartedAt: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2400, text: 'hold on' },
        { type: 'USER_TRANSCRIPT', at: 3500, text: 'hold on a second' },
        { type: 'USER_SPEECH_END', at: 3600 },
      ],
      botMidSecondSentence().state,
    );
    const user = users(state)[0];
    const bot = bots(state)[0];
    expect(user.startedAt).toBe(2000);
    expect(user.endedAt).toBe(3600);
    expect(bot.stoppedAt).toBe(2400); // when we could be sure, used for reaction latency
    expect(user.startedAt).toBeLessThan(bot.stoppedAt!);
  });

  it('also uses speech start when the interrupt is only confirmed at speech end', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2200, text: 'no no' },
        { type: 'USER_SPEECH_END', at: 2000 + NOISE_GATE_MS + 50 }, // timer never fired
      ],
      botMidSecondSentence().state,
    );
    expect(transitions.at(-1)).toBe('interrupt_confirmed_at_speech_end');
    expect(users(state)[0].startedAt).toBe(2000);
    expect(state.phase).toBe('processing');
  });
});

describe('edge case: rapid double interrupts', () => {
  it('merges two quick typed interrupts into one user turn and one live reply', () => {
    const { state, effects, transitions } = run(
      [
        { type: 'USER_TYPED', at: 2100, text: 'stop' },
        { type: 'USER_TYPED', at: 2250, text: 'actually tell me a story' },
        { type: 'BOT_CHUNK', at: 2400, turnId: 3, text: 'Reply to just "stop".' },
        { type: 'BOT_CHUNK', at: 2500, turnId: 4, text: 'Once upon a time.' },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions).toEqual([
      'typed_interrupt',
      'reply_cancelled_user_typed_more',
      'stale_chunk_dropped',
      'reply_started',
    ]);
    expect(bots(state).filter((b) => b.status === 'interrupted')).toHaveLength(1);
    expect(users(state).map((u) => u.text)).toEqual(['stop actually tell me a story']);
    expect(effects.filter((e) => e.type === 'speak')).toEqual([
      { type: 'speak', turnId: 4, index: 0, text: 'Once upon a time.' },
    ]);
  });

  it('ignores a duplicate speech start and its second noise gate', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_SPEECH_START', at: 2050 },
        { type: 'NOISE_GATE_ELAPSED', at: 2350, speechStartedAt: 2050 },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions).toEqual(['overlap_began', 'duplicate_speech_start_ignored', 'stale_noise_gate_ignored']);
    expect(state.phase).toBe('overlap');
    expect(state.utterance?.startedAt).toBe(2000);
  });

  it('handles a voice interrupt that lands while the reply is still being generated', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_TYPED', at: 2100, text: 'wait' },
        { type: 'USER_SPEECH_START', at: 2200 },
        { type: 'USER_TRANSCRIPT', at: 2500, text: 'what was that' },
        { type: 'USER_SPEECH_END', at: 2700 },
        { type: 'BOT_CHUNK', at: 2750, turnId: 3, text: 'Old reply.' },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions[1]).toBe('reply_cancelled_user_resumed');
    expect(transitions.at(-1)).toBe('stale_chunk_dropped');
    expect(users(state)).toHaveLength(1);
    expect(users(state)[0].text).toBe('wait what was that');
    expect(state.awaitingReplyId).toBe(4);
  });
});

describe('edge case: short noise is not an interrupt', () => {
  it('ignores speech shorter than the noise gate even with words', () => {
    const { state, effects, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2100, text: 'uh' },
        { type: 'USER_SPEECH_END', at: 2000 + NOISE_GATE_MS - 1 },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions.at(-1)).toBe('noise_ignored');
    expect(state.phase).toBe('bot_speaking');
    expect(bots(state)[0].status).toBe('live');
    expect(effects.some((e) => e.type === 'stopSpeaking')).toBe(false);
  });

  it('ignores long sound with an empty transcript', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'NOISE_GATE_ELAPSED', at: 2300, speechStartedAt: 2000 },
        { type: 'USER_TRANSCRIPT', at: 2400, text: '   ' },
        { type: 'USER_SPEECH_END', at: 2900 },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions).toEqual([
      'overlap_began',
      'noise_gate_passed_waiting_for_words',
      'overlap_text_buffered',
      'noise_ignored',
    ]);
    expect(state.phase).toBe('bot_speaking');
    expect(state.turns).toHaveLength(1);
  });

  it('lets the bot keep talking after a blip', () => {
    const { state, effects } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_SPEECH_END', at: 2100 },
        { type: 'TTS_END', at: 2600, turnId: 1, index: 1 },
      ],
      botMidSecondSentence().state,
    );
    expect(effects).toEqual([{ type: 'startNoiseGate', speechStartedAt: 2000, ms: NOISE_GATE_MS }]);
    expect(state.phase).toBe('idle');
    expect(bots(state)[0].status).toBe('done');
  });

  it('does not let a gate timer from an earlier blip confirm a later utterance', () => {
    const { state, transitions } = run(
      [
        { type: 'USER_SPEECH_START', at: 2000 },
        { type: 'USER_SPEECH_END', at: 2100 },
        { type: 'USER_SPEECH_START', at: 2200 },
        { type: 'USER_TRANSCRIPT', at: 2250, text: 'hey' },
        { type: 'NOISE_GATE_ELAPSED', at: 2300, speechStartedAt: 2000 },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions.at(-1)).toBe('stale_noise_gate_ignored');
    expect(state.phase).toBe('overlap');
  });

  it('drops an empty user turn when nobody was talking over', () => {
    const { state, effects } = run(
      [
        { type: 'TTS_END', at: 2500, turnId: 1, index: 1 },
        { type: 'USER_SPEECH_START', at: 3000 },
        { type: 'USER_SPEECH_END', at: 3100 },
      ],
      botMidSecondSentence().state,
    );
    expect(state.phase).toBe('idle');
    expect(users(state)).toHaveLength(0);
    expect(effects).toEqual([]);
  });
});

describe('reset', () => {
  it('clears the conversation and stops the voice', () => {
    const { state, effects } = run([{ type: 'RESET', at: 5000 }], botMidSecondSentence().state);
    expect(state).toEqual({ ...initialState(), nextId: 2 });
    expect(effects).toEqual([{ type: 'stopSpeaking' }]);
  });

  it('does not let a late chunk from the old conversation into the new one', () => {
    const { state, transitions } = run(
      [
        { type: 'RESET', at: 5000 },
        { type: 'START', at: 5100 }, // asks for turn 2
        { type: 'BOT_CHUNK', at: 5200, turnId: 1, text: 'Old opener.' },
      ],
      botMidSecondSentence().state,
    );
    expect(transitions.at(-1)).toBe('stale_chunk_dropped');
    expect(state.awaitingReplyId).toBe(2);
  });
});
