// The interrupt state machine. Pure: no timers, no DOM, no speech APIs.
// Adapters turn browser callbacks into Events, and the app runs the Effects.

export const NOISE_GATE_MS = 300;

export type Phase = 'idle' | 'processing' | 'bot_speaking' | 'overlap' | 'user_speaking';

export interface BotTurn {
  kind: 'bot';
  id: number;
  startedAt: number;
  sentences: string[]; // everything generated so far
  spoken: number; // sentences fully played
  heardChars: number; // characters played of sentences[spoken]
  speaking: boolean; // a sentence is playing right now
  streamDone: boolean; // the generator sent its last chunk
  status: 'live' | 'done' | 'interrupted';
  stoppedAt?: number; // when we stopped the voice after an interrupt
}

export interface UserTurn {
  kind: 'user';
  id: number;
  startedAt: number; // speech START, not when recognition finished
  endedAt?: number;
  text: string;
  status: 'live' | 'done';
}

export type Turn = BotTurn | UserTurn;

// User speech that is in progress. During overlap it is only a candidate interrupt.
export interface Utterance {
  startedAt: number;
  text: string;
  gateElapsed: boolean;
}

export interface State {
  phase: Phase;
  started: boolean; // once true, the opener is never requested again
  nextId: number;
  turns: Turn[];
  activeBotId: number | null; // bot turn being spoken (bot_speaking and overlap)
  awaitingReplyId: number | null; // reply requested but not yet arrived (processing)
  utterance: Utterance | null;
}

export type Event =
  | { type: 'START'; at: number }
  | { type: 'RESET'; at: number }
  | { type: 'BOT_CHUNK'; at: number; turnId: number; text: string }
  | { type: 'BOT_DONE'; at: number; turnId: number }
  | { type: 'TTS_PROGRESS'; at: number; turnId: number; index: number; chars: number }
  | { type: 'TTS_END'; at: number; turnId: number; index: number }
  | { type: 'USER_SPEECH_START'; at: number }
  | { type: 'USER_TRANSCRIPT'; at: number; text: string }
  | { type: 'NOISE_GATE_ELAPSED'; at: number; speechStartedAt: number }
  | { type: 'USER_SPEECH_END'; at: number }
  | { type: 'USER_TYPED'; at: number; text: string };

// Adapters build events without a timestamp and the app stamps `at`.
// Omit on a union would merge the members, so this applies it to each one.
export type Unstamped<E> = E extends Event ? Omit<E, 'at'> : never;

export interface Message {
  role: 'bot' | 'user';
  text: string;
}

export type Effect =
  | { type: 'generate'; turnId: number; userText: string | null; history: Message[] }
  | { type: 'speak'; turnId: number; index: number; text: string }
  | { type: 'stopSpeaking' }
  | { type: 'startNoiseGate'; speechStartedAt: number; ms: number };

export interface Result {
  state: State;
  effects: Effect[];
  transition: string; // a name for what happened, shown in the event log
}

export function initialState(): State {
  return {
    phase: 'idle',
    started: false,
    nextId: 1,
    turns: [],
    activeBotId: null,
    awaitingReplyId: null,
    utterance: null,
  };
}

export function reduce(state: State, event: Event): Result {
  switch (event.type) {
    case 'START':
      return onStart(state);
    case 'RESET':
      // Keep counting ids so late events from the old conversation still look stale.
      return { state: { ...initialState(), nextId: state.nextId }, effects: [{ type: 'stopSpeaking' }], transition: 'reset' };
    case 'BOT_CHUNK':
      return onBotChunk(state, event.turnId, event.text, event.at);
    case 'BOT_DONE':
      return onBotDone(state, event.turnId);
    case 'TTS_PROGRESS':
      return onTtsProgress(state, event.turnId, event.index, event.chars);
    case 'TTS_END':
      return onTtsEnd(state, event.turnId, event.index);
    case 'USER_SPEECH_START':
      return onSpeechStart(state, event.at);
    case 'USER_TRANSCRIPT':
      return onTranscript(state, event.text, event.at);
    case 'NOISE_GATE_ELAPSED':
      return onNoiseGate(state, event.speechStartedAt, event.at);
    case 'USER_SPEECH_END':
      return onSpeechEnd(state, event.at);
    case 'USER_TYPED':
      return onTyped(state, event.text, event.at);
  }
}

// ---------- event handlers ----------

function onStart(state: State): Result {
  if (state.started) return nothing(state, 'start_ignored_already_started');
  const id = state.nextId;
  return {
    state: { ...state, started: true, phase: 'processing', nextId: id + 1, awaitingReplyId: id },
    effects: [{ type: 'generate', turnId: id, userText: null, history: [] }],
    transition: 'opener_requested',
  };
}

function onBotChunk(state: State, turnId: number, text: string, at: number): Result {
  if (turnId === state.awaitingReplyId) {
    const turn: BotTurn = {
      kind: 'bot',
      id: turnId,
      startedAt: at,
      sentences: [text],
      spoken: 0,
      heardChars: 0,
      speaking: true,
      streamDone: false,
      status: 'live',
    };
    return {
      state: {
        ...state,
        phase: 'bot_speaking',
        awaitingReplyId: null,
        activeBotId: turnId,
        turns: [...state.turns, turn],
      },
      effects: [speak(turn, 0)],
      transition: 'reply_started',
    };
  }

  const bot = activeBot(state);
  if (!bot || bot.id !== turnId) return nothing(state, 'stale_chunk_dropped');

  const grown = { ...bot, sentences: [...bot.sentences, text] };
  if (bot.speaking) return { state: withBot(state, grown), effects: [], transition: 'chunk_queued' };
  const playing = { ...grown, speaking: true };
  return { state: withBot(state, playing), effects: [speak(playing, playing.spoken)], transition: 'chunk_spoken' };
}

function onBotDone(state: State, turnId: number): Result {
  const bot = activeBot(state);
  if (!bot || bot.id !== turnId) return nothing(state, 'stale_done_dropped');
  return finishBotIfDone(withBot(state, { ...bot, streamDone: true }), 'stream_done');
}

function onTtsProgress(state: State, turnId: number, index: number, chars: number): Result {
  const bot = activeBot(state);
  if (!bot || bot.id !== turnId || bot.spoken !== index) return nothing(state, 'stale_tts_dropped');
  const heardChars = Math.max(bot.heardChars, chars);
  return { state: withBot(state, { ...bot, heardChars }), effects: [], transition: 'tts_progress' };
}

function onTtsEnd(state: State, turnId: number, index: number): Result {
  // After an interrupt, cancelling the voice fires a late "end" for the cut sentence.
  // The turn is no longer active, so it lands here and is dropped.
  const bot = activeBot(state);
  if (!bot || bot.id !== turnId || bot.spoken !== index) return nothing(state, 'stale_tts_dropped');

  const finished = { ...bot, spoken: bot.spoken + 1, heardChars: 0, speaking: false };
  if (finished.spoken < finished.sentences.length) {
    const next = { ...finished, speaking: true };
    return { state: withBot(state, next), effects: [speak(next, next.spoken)], transition: 'next_sentence' };
  }
  return finishBotIfDone(withBot(state, finished), 'waiting_for_next_chunk');
}

function onSpeechStart(state: State, at: number): Result {
  const utterance: Utterance = { startedAt: at, text: '', gateElapsed: false };
  switch (state.phase) {
    case 'bot_speaking':
      // Do not stop the bot yet. It might just be a cough.
      return {
        state: { ...state, phase: 'overlap', utterance },
        effects: [{ type: 'startNoiseGate', speechStartedAt: at, ms: NOISE_GATE_MS }],
        transition: 'overlap_began',
      };
    case 'idle':
      return { state: openUserTurn({ ...state, utterance }, at), effects: [], transition: 'user_turn_began' };
    case 'processing':
      // Before the greeting has played there is no user turn to resume. Cancelling here
      // would drop the greeting for good, so the sound is ignored and the greeting plays.
      if (lastTurn(state)?.kind !== 'user') return nothing(state, 'speech_before_greeting_ignored');
      // The user kept talking before the reply arrived. Forget that reply and keep listening.
      return {
        state: openUserTurn({ ...state, utterance, awaitingReplyId: null }, at),
        effects: [],
        transition: 'reply_cancelled_user_resumed',
      };
    default:
      return nothing(state, 'duplicate_speech_start_ignored');
  }
}

function onTranscript(state: State, text: string, at: number): Result {
  if (!state.utterance) return nothing(state, 'transcript_without_speech_ignored');
  // Buffer the words in every phase, including overlap, so the start of the sentence is kept.
  const buffered = { ...state, utterance: { ...state.utterance, text } };
  if (state.phase === 'overlap') return confirmIfRealSpeech(buffered, at, 'overlap_text_buffered');
  return { state: buffered, effects: [], transition: 'user_text_updated' };
}

function onNoiseGate(state: State, speechStartedAt: number, at: number): Result {
  const u = state.utterance;
  if (state.phase !== 'overlap' || !u || u.startedAt !== speechStartedAt) {
    return nothing(state, 'stale_noise_gate_ignored');
  }
  const elapsed = { ...state, utterance: { ...u, gateElapsed: true } };
  return confirmIfRealSpeech(elapsed, at, 'noise_gate_passed_waiting_for_words');
}

function onSpeechEnd(state: State, at: number): Result {
  if (!state.utterance) return nothing(state, 'speech_end_ignored');

  if (state.phase === 'overlap') {
    if (!isRealSpeech(state.utterance, at)) {
      return { state: { ...state, phase: 'bot_speaking', utterance: null }, effects: [], transition: 'noise_ignored' };
    }
    const interrupted = interrupt(state, at);
    const ended = closeUserTurn(interrupted.state, at);
    return {
      state: ended.state,
      effects: [...interrupted.effects, ...ended.effects],
      transition: 'interrupt_confirmed_at_speech_end',
    };
  }
  return closeUserTurn(state, at);
}

function onTyped(state: State, rawText: string, at: number): Result {
  const text = rawText.trim();
  if (!text) return nothing(state, 'empty_text_ignored');

  if (state.phase === 'user_speaking') {
    const turn = lastTurn(state) as UserTurn;
    return { state: replaceLast(state, { ...turn, text: join(turn.text, text) }), effects: [], transition: 'typed_text_added' };
  }

  // Typing is deliberate, so it skips the noise gate. Any buffered speech is kept.
  const u = state.utterance;
  const utterance: Utterance = { startedAt: u?.startedAt ?? at, text: join(u?.text ?? '', text), gateElapsed: true };
  const typed = { ...state, utterance };

  if (state.phase === 'bot_speaking' || state.phase === 'overlap') {
    const interrupted = interrupt(typed, at);
    const ended = closeUserTurn(interrupted.state, at);
    return { state: ended.state, effects: [...interrupted.effects, ...ended.effects], transition: 'typed_interrupt' };
  }
  if (state.phase === 'processing') {
    const ended = closeUserTurn(openUserTurn({ ...typed, awaitingReplyId: null }, at), at);
    return { ...ended, transition: 'reply_cancelled_user_typed_more' };
  }
  return { ...closeUserTurn(openUserTurn(typed, at), at), transition: 'typed_turn' };
}

// ---------- shared steps ----------

function isRealSpeech(u: Utterance, at: number): boolean {
  const longEnough = u.gateElapsed || at - u.startedAt >= NOISE_GATE_MS;
  return longEnough && u.text.trim() !== '';
}

function confirmIfRealSpeech(state: State, at: number, otherwise: string): Result {
  if (!isRealSpeech(state.utterance!, at)) return nothing(state, otherwise);
  return interrupt(state, at);
}

// Stop the bot and hand the floor to the user. The bot turn keeps spoken and
// heardChars as they were, which is exactly the text the user heard.
function interrupt(state: State, at: number): Result {
  const bot = activeBot(state)!;
  const stopped: BotTurn = { ...bot, status: 'interrupted', speaking: false, stoppedAt: at };
  const next = openUserTurn({ ...withBot(state, stopped), activeBotId: null }, state.utterance!.startedAt);
  return { state: next, effects: [{ type: 'stopSpeaking' }], transition: 'interrupt_confirmed' };
}

// If the bot has not spoken since the user's last turn, the user is still holding
// the floor, so we reopen that turn instead of starting a new one.
function openUserTurn(state: State, startedAt: number): State {
  const last = lastTurn(state);
  if (last?.kind === 'user') {
    return { ...replaceLast(state, { ...last, status: 'live', endedAt: undefined }), phase: 'user_speaking' };
  }
  const turn: UserTurn = { kind: 'user', id: state.nextId, startedAt, text: '', status: 'live' };
  return { ...state, phase: 'user_speaking', nextId: state.nextId + 1, turns: [...state.turns, turn] };
}

function closeUserTurn(state: State, at: number): Result {
  const turn = lastTurn(state) as UserTurn;
  const text = join(turn.text, state.utterance?.text ?? '');
  const cleared = { ...state, utterance: null };

  if (text === '') {
    const turns = cleared.turns.slice(0, -1);
    return { state: { ...cleared, turns, phase: 'idle' }, effects: [], transition: 'empty_user_turn_dropped' };
  }

  const id = state.nextId;
  const done: UserTurn = { ...turn, text, status: 'done', endedAt: at };
  const next: State = {
    ...replaceLast(cleared, done),
    started: true, // the user spoke first, so there is no opener to play later
    phase: 'processing',
    nextId: id + 1,
    awaitingReplyId: id,
  };
  return {
    state: next,
    effects: [{ type: 'generate', turnId: id, userText: text, history: history(next.turns) }],
    transition: 'user_turn_ended',
  };
}

function finishBotIfDone(state: State, otherwise: string): Result {
  const bot = activeBot(state)!;
  if (bot.speaking || !bot.streamDone || bot.spoken < bot.sentences.length) return nothing(state, otherwise);

  const done = { ...withBot(state, { ...bot, status: 'done' }), activeBotId: null };
  if (state.phase === 'overlap') {
    // The bot ran out of words while the user was talking. Nothing to cut; it is simply their turn.
    return { state: openUserTurn(done, state.utterance!.startedAt), effects: [], transition: 'bot_finished_during_overlap' };
  }
  return { state: { ...done, phase: 'idle' }, effects: [], transition: 'bot_turn_complete' };
}

// ---------- read helpers (also used by the UI) ----------

export function deliveredText(turn: BotTurn): string {
  const partial = (turn.sentences[turn.spoken] ?? '').slice(0, turn.heardChars).trim();
  return [...turn.sentences.slice(0, turn.spoken), partial].filter(Boolean).join(' ');
}

export function undeliveredText(turn: BotTurn): string {
  const rest = (turn.sentences[turn.spoken] ?? '').slice(turn.heardChars).trim();
  return [rest, ...turn.sentences.slice(turn.spoken + 1)].filter(Boolean).join(' ');
}

// What the responder is allowed to see: bot turns count only the words that were heard.
export function history(turns: Turn[]): Message[] {
  return turns
    .map((t): Message => (t.kind === 'user' ? { role: 'user', text: t.text } : { role: 'bot', text: deliveredText(t) }))
    .filter((m) => m.text !== '');
}

function activeBot(state: State): BotTurn | undefined {
  return state.turns.find((t): t is BotTurn => t.kind === 'bot' && t.id === state.activeBotId);
}

function withBot(state: State, bot: BotTurn): State {
  return { ...state, turns: state.turns.map((t) => (t.kind === 'bot' && t.id === bot.id ? bot : t)) };
}

function lastTurn(state: State): Turn | undefined {
  return state.turns[state.turns.length - 1];
}

function replaceLast(state: State, turn: Turn): State {
  return { ...state, turns: [...state.turns.slice(0, -1), turn] };
}

function speak(turn: BotTurn, index: number): Effect {
  return { type: 'speak', turnId: turn.id, index, text: turn.sentences[index] };
}

function join(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(' ');
}

function nothing(state: State, transition: string): Result {
  return { state, effects: [], transition };
}
