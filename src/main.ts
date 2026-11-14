// The app shell: owns the current state, feeds events to the reducer, runs the
// effects it returns, and draws the page. All decisions live in machine.ts.
import './style.css';
import { Effect, Event, NOISE_GATE_MS, Phase, State, Turn, Unstamped, deliveredText, initialState, reduce, undeliveredText } from './machine';
import { createMic, micSupported } from './mic';
import { respond, streamReply } from './responder';
import { SCENARIOS, playScenario } from './scenarios';
import { canSpeakAloud, createBrowserVoice, createSilentVoice } from './voice';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const startButton = el<HTMLButtonElement>('start');
const micToggle = el<HTMLInputElement>('mic');
const aloudToggle = el<HTMLInputElement>('aloud');
const typedInput = el<HTMLInputElement>('typed');
const sendButton = el<HTMLButtonElement>('send');

let state: State = initialState();
const pageLoadedAt = performance.now();
const now = () => Math.round(performance.now() - pageLoadedAt);

interface LogEntry {
  at: number;
  event: string;
  from: Phase;
  to: Phase;
  transition: string;
}
const log: LogEntry[] = [];

// An effect can send an event synchronously (the silent voice does). Queueing makes
// sure the reducer still handles one event at a time, in the order they were sent.
const queue: Event[] = [];
let draining = false;

function send(input: Unstamped<Event>): void {
  queue.push({ ...input, at: now() } as Event);
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const event = queue.shift()!;
    const from = state.phase;
    const result = reduce(state, event);
    state = result.state;
    if (event.type !== 'TTS_PROGRESS') {
      log.unshift({ at: event.at, event: describe(event), from, to: state.phase, transition: result.transition });
    }
    result.effects.forEach(runEffect);
  }
  log.length = Math.min(log.length, 200);
  draining = false;
  render();
}

const browserVoice = canSpeakAloud ? createBrowserVoice(send) : null;
const silentVoice = createSilentVoice(send);
const mic = createMic(send, showNotice);

function runEffect(effect: Effect): void {
  switch (effect.type) {
    case 'generate':
      streamReply(effect.turnId, respond(effect.userText, effect.history), send);
      break;
    case 'speak': {
      const voice = aloudToggle.checked && browserVoice ? browserVoice : silentVoice;
      voice.speak(effect.turnId, effect.index, effect.text);
      break;
    }
    case 'stopSpeaking':
      browserVoice?.stop();
      silentVoice.stop();
      break;
    case 'startNoiseGate':
      setTimeout(() => send({ type: 'NOISE_GATE_ELAPSED', speechStartedAt: effect.speechStartedAt }), effect.ms);
      break;
  }
}

// ---------- controls ----------

let stopScenario = () => {};

startButton.addEventListener('click', () => {
  stopScenario();
  send({ type: state.started ? 'RESET' : 'START' });
});

el('scenarios').innerHTML = SCENARIOS.map((s, i) => `<button data-index="${i}"${i === 0 ? ' class="primary"' : ''}>${s.name}</button>`).join('');
el('scenarios').addEventListener('click', (e) => {
  const index = (e.target as HTMLElement).dataset.index;
  if (index === undefined) return;
  const scenario = SCENARIOS[Number(index)];
  stopScenario();
  el('scenario-about').textContent = scenario.about;
  log.length = 0; // so the log reads as just this scenario
  stopScenario = playScenario(scenario, send);
});

el('type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'USER_TYPED', text: typedInput.value.trim() || 'Wait, hold on.' });
  typedInput.value = '';
});

if (!micSupported) {
  micToggle.disabled = true;
  el('mic-label').textContent = 'Microphone (needs Chrome or Edge)';
}
micToggle.addEventListener('change', () => {
  if (!micToggle.checked) {
    mic.stop();
    showNotice('');
    return;
  }
  mic.start();
  const embedded = window.self !== window.top;
  showNotice(
    embedded
      ? 'Embedded previews often block the mic. If nothing happens, open the app in a new tab.'
      : 'Listening. Wear headphones so the mic does not hear the bot and interrupt itself.',
  );
});

if (!canSpeakAloud) {
  aloudToggle.checked = false;
  aloudToggle.disabled = true;
}

function showNotice(message: string): void {
  const notice = el('notice');
  notice.textContent = message;
  notice.hidden = message === '';
  if (message.startsWith('Microphone blocked')) micToggle.checked = false;
}

// ---------- rendering ----------

const PHASES: Phase[] = ['idle', 'processing', 'bot_speaking', 'overlap', 'user_speaking'];

const PHASE_HELP: Record<Phase, string> = {
  idle: 'Nobody is talking. Press Start, type, or speak.',
  processing: 'Waiting for the reply to stream in. Speaking or typing now cancels it and adds to your turn.',
  bot_speaking: 'The bot is talking. Any speech from you opens an overlap.',
  overlap: 'You and the bot are both talking. The bot keeps going until your speech passes the noise gate (300ms and real words).',
  user_speaking: 'The bot has stopped. Your words are collected until you finish.',
};

function render(): void {
  startButton.textContent = state.started ? 'Reset' : 'Start conversation';
  const botTalking = state.phase === 'bot_speaking' || state.phase === 'overlap';
  sendButton.textContent = botTalking ? 'Interrupt' : 'Send';

  el('phases').innerHTML = PHASES.map((p) => `<li class="${p === state.phase ? 'active' : ''}">${p}</li>`).join('');
  el('phase-help').textContent = PHASE_HELP[state.phase];
  el('facts').innerHTML = [
    ['Buffered speech', state.utterance ? `"${state.utterance.text}"` : 'none'],
    ['Speaking turn', state.activeBotId ?? 'none'],
    ['Awaiting reply', state.awaitingReplyId ?? 'none'],
    ['Last reaction', lastReaction()],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${escape(String(v))}</dd>`)
    .join('');

  renderTranscript();

  el('log').innerHTML = log
    .map((entry) => {
      const quiet = /stale|ignored|dropped/.test(entry.transition);
      const move = entry.from === entry.to ? entry.to : `${entry.from} → ${entry.to}`;
      return `<li><time>${seconds(entry.at)}</time><div>${escape(entry.event)}<br><span class="${quiet ? 'stale' : 'transition'}">${entry.transition}</span> · ${move}</div></li>`;
    })
    .join('') || '<li class="empty">Events appear here as they happen.</li>';
}

function renderTranscript(): void {
  const box = el('transcript');
  const parts = state.turns.map((turn, i) => renderTurn(turn, state.turns[i + 1]));
  if (state.phase === 'overlap' && state.utterance) {
    const words = state.utterance.text || '...';
    parts.push(`<article class="turn user tentative"><header>You (maybe an interrupt)</header><p class="live">${escape(words)}</p></article>`);
  }
  if (state.phase === 'processing') parts.push('<p class="empty">Bot is thinking...</p>');
  box.innerHTML = parts.join('') || '<p class="empty">Press Start conversation, or try a scripted scenario.</p>';
  box.scrollTop = box.scrollHeight;
}

function renderTurn(turn: Turn, next: Turn | undefined): string {
  if (turn.kind === 'user') {
    const live = turn.status === 'live' && state.utterance ? ` <span class="live">${escape(state.utterance.text)}</span>` : '';
    return `<article class="turn user"><header>You <time>${seconds(turn.startedAt)}</time></header><p>${escape(turn.text)}${live}</p></article>`;
  }
  const restClass = turn.status === 'interrupted' ? 'cut' : 'pending';
  let footer = '';
  if (turn.status === 'interrupted' && next?.kind === 'user') {
    const latency = turn.stoppedAt! - next.startedAt;
    const reaction = latency > 0 ? ` Stop sent ${latency}ms after you started talking (the noise gate is ${NOISE_GATE_MS}ms).` : '';
    footer = `<footer>Interrupted at ${seconds(next.startedAt)}.${reaction} Struck text was never heard.</footer>`;
  }
  return `<article class="turn bot"><header>Bot <time>${seconds(turn.startedAt)}</time></header><p>${escape(deliveredText(turn))} <span class="${restClass}">${escape(undeliveredText(turn))}</span></p>${footer}</article>`;
}

function lastReaction(): string {
  for (let i = state.turns.length - 2; i >= 0; i--) {
    const turn = state.turns[i];
    const next = state.turns[i + 1];
    // Typed interrupts stop the voice instantly, so only voice interrupts have a reaction time.
    if (turn.kind === 'bot' && turn.status === 'interrupted' && next.kind === 'user' && turn.stoppedAt! > next.startedAt) {
      return `${turn.stoppedAt! - next.startedAt}ms from speech start to stop (gate ${NOISE_GATE_MS}ms)`;
    }
  }
  return 'no voice interrupts yet';
}

function describe(event: Event): string {
  switch (event.type) {
    case 'BOT_CHUNK':
      return `BOT_CHUNK turn ${event.turnId} "${event.text}"`;
    case 'BOT_DONE':
      return `BOT_DONE turn ${event.turnId}`;
    case 'TTS_END':
      return `TTS_END turn ${event.turnId} sentence ${event.index}`;
    case 'USER_TRANSCRIPT':
    case 'USER_TYPED':
      return `${event.type} "${event.text}"`;
    case 'NOISE_GATE_ELAPSED':
      return `NOISE_GATE_ELAPSED for speech at ${seconds(event.speechStartedAt)}`;
    default:
      return event.type;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

render();
