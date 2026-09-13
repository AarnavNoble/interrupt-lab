# Interrupt Lab

A voice agent you can interrupt in the browser, with its state machine made visible.

The bot reads a multi-sentence reply out loud, one streamed sentence at a time. You can cut it off by speaking, typing, or pressing Interrupt. It stops right away, keeps only the words you actually heard, and replies to what you said. A phase strip, an event log, and a transcript show every decision as it happens.

## Why I built it

On my last co-op I worked on a real-time voice AI product, where letting users barge in on the bot turned out to be one of the hardest parts to get right. The obvious version drops the first words of the interruption, replays the greeting, records timestamps from the wrong moment, or saves bot text the user never heard.

This project is a small, from-scratch public demo of the general idea: model the conversation as a pure state machine, then give every awkward event ordering a name and a test. It shares no code or design details with any employer.

## What is in here

| File | What it does |
| --- | --- |
| `src/machine.ts` | The pure reducer: `(state, event) => { state, effects, transition }`. No browser APIs. |
| `src/machine.test.ts` | Vitest tests for every edge case, using fake events. |
| `src/voice.ts` | Bot voice. The browser `speechSynthesis` voice and a silent fixed-speed voice. |
| `src/mic.ts` | Browser speech recognition, turned into speech start, transcript, and speech end events. |
| `src/responder.ts` | A deterministic rule based responder that streams its reply sentence by sentence. |
| `src/scenarios.ts` | Scripted conversations that fake the user's side on a timer. |
| `src/main.ts` | Wires it together: dispatches events, runs effects, draws the page. |
| `DESIGN.md` | The state diagram, every transition, and the reasoning behind them. |

There is no backend, no LLM, and no API key.

## Run it locally

You need Node 20 or newer.

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # reducer tests
npm run build   # typecheck and production build
```

## Run it on Replit

Import the repo (or upload the folder) and press **Run**. The `.replit` file installs dependencies and starts Vite on `0.0.0.0:5173`, which Replit exposes as the web preview. `vite.config.ts` allows any host so Replit's proxy domain is not rejected.

## Trying it

1. **No mic needed:** click any button under "Replay a scripted scenario". Each one fakes the user's side of a conversation so you can watch the phases, the log, and the struck-through undelivered text.
2. **Typing:** press Start conversation, then type something (try "tell me a story") and press Interrupt while the bot is talking. Afterwards, ask "what did you just say" to see that the bot only remembers what you heard.
3. **Voice:** turn on Microphone and talk over the bot.

### Microphone notes

- Speech recognition only works in **Chrome or Edge**. Firefox and Safari can still use typing and the scenarios.
- Replit's embedded preview usually blocks the microphone. **Open the app in a new tab** (the arrow icon in the preview toolbar) and allow mic access.
- Wear headphones. Otherwise the mic can hear the bot's own voice and it will interrupt itself.
- Chrome's recognizer sends audio to Google's speech service. Nothing is sent anywhere else.
- If Speak aloud is off or unsupported, a silent voice reads at a fixed speed instead, and everything else behaves the same.
