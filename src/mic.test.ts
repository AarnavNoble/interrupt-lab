import { expect, it, vi } from 'vitest';

// A stand-in for the browser recognizer: abort() ends the session asynchronously, like Chrome.
const sessions: FakeRecognition[] = [];
class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  active = false;
  onspeechstart: (() => void) | null = null;
  onresult: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  start() {
    this.active = true;
    sessions.push(this);
  }
  abort() {
    this.active = false;
    queueMicrotask(() => this.onend?.());
  }
}
vi.stubGlobal('window', { SpeechRecognition: FakeRecognition });

it('turning the mic off and on quickly leaves exactly one session listening', async () => {
  const { createMic } = await import('./mic');
  const mic = createMic(() => {}, () => {});
  mic.start();
  mic.stop();
  mic.start(); // before the first session's onend has fired
  await Promise.resolve();
  await Promise.resolve();
  expect(sessions.filter((s) => s.active)).toHaveLength(1);
});
