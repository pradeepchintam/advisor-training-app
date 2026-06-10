import { useRef, useState } from 'react';
import { SimliClient } from 'simli-client';
import api from '../services/api';
import { useToast } from '../components/Toast';
import { getErrorMessage } from '../utils/errors';

/**
 * LOCAL TRIAL of Simli realtime photoreal avatars (couple).
 *
 * Two avatar video tiles (Margaret = Tina face, Tom = Fred face) driven by
 * the existing ElevenLabs voice. Type a line, pick the speaker, and that
 * avatar lip-syncs it in their own voice — proving the photoreal couple +
 * ElevenLabs audio + latency, isolated from the production session.
 */

interface AvatarHandle {
  client: SimliClient;
  video: HTMLVideoElement;
  audio: HTMLAudioElement;
}

export default function AvatarTrial() {
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const primaryVideoRef = useRef<HTMLVideoElement | null>(null);
  const primaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const spouseVideoRef = useRef<HTMLVideoElement | null>(null);
  const spouseAudioRef = useRef<HTMLAudioElement | null>(null);
  const primaryRef = useRef<AvatarHandle | null>(null);
  const spouseRef = useRef<AvatarHandle | null>(null);

  const start = async () => {
    setConnecting(true);
    try {
      const { data } = await api.post('/simli-trial/start', {});
      const mk = (
        token: string,
        v: HTMLVideoElement,
        a: HTMLAudioElement,
      ): AvatarHandle => {
        // Constructor: (session_token, videoElement, audioElement, iceServers)
        const client = new SimliClient(token, v, a, null);
        return { client, video: v, audio: a };
      };
      primaryRef.current = mk(
        data.primary.session_token, primaryVideoRef.current!, primaryAudioRef.current!,
      );
      spouseRef.current = mk(
        data.spouse.session_token, spouseVideoRef.current!, spouseAudioRef.current!,
      );
      await Promise.all([
        primaryRef.current.client.start(),
        spouseRef.current.client.start(),
      ]);
      setReady(true);
    } catch (err) {
      toast.error(`Couldn't start avatars: ${getErrorMessage(err)}`);
    } finally {
      setConnecting(false);
    }
  };

  const say = async (speaker: 'primary' | 'spouse') => {
    const line = text.trim();
    if (!line) { toast.warning('Type a line first.'); return; }
    const handle = speaker === 'primary' ? primaryRef.current : spouseRef.current;
    if (!handle) return;
    setBusy(true);
    try {
      // Fetch raw PCM16 @16kHz from ElevenLabs (via our backend).
      const token = localStorage.getItem('auth_token');
      const resp = await fetch(`${api.defaults.baseURL ?? '/api'}/simli-trial/say`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: line, speaker }),
      });
      if (!resp.ok) throw new Error(`say ${resp.status}`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      // Clear any audio still queued on that avatar, then feed in chunks.
      handle.client.ClearBuffer();
      const CHUNK = 6000; // bytes (~3000 samples)
      for (let i = 0; i < buf.length; i += CHUNK) {
        handle.client.sendAudioData(buf.subarray(i, Math.min(i + CHUNK, buf.length)));
      }
    } catch (err) {
      toast.error(`TTS failed: ${getErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    try { primaryRef.current?.client.stop(); } catch { /* ignore */ }
    try { spouseRef.current?.client.stop(); } catch { /* ignore */ }
    primaryRef.current = null;
    spouseRef.current = null;
    setReady(false);
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Simli Avatars — Couple Trial</h1>
        <p className="text-slate-500 mt-1 text-sm">
          Isolated spike: two photoreal talking-head avatars (preset faces) driven by your
          ElevenLabs voices. Type a line, pick who says it. Production session untouched.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        {[
          { label: 'Margaret (wife)', v: primaryVideoRef, a: primaryAudioRef },
          { label: 'Tom (husband)', v: spouseVideoRef, a: spouseAudioRef },
        ].map((tile) => (
          <div key={tile.label} className="bg-navy-800 border border-navy-700 rounded-xl overflow-hidden">
            <div className="aspect-square bg-navy-950 flex items-center justify-center">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={tile.v}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              <audio ref={tile.a} autoPlay />
            </div>
            <div className="px-3 py-2 text-center text-slate-300 text-sm">{tile.label}</div>
          </div>
        ))}
      </div>

      {!ready ? (
        <button
          onClick={start}
          disabled={connecting}
          className="w-full bg-gold-500 hover:bg-gold-400 disabled:opacity-60 text-navy-900 font-bold py-3 rounded-lg transition-colors"
        >
          {connecting ? 'Connecting avatars…' : 'Start Avatars'}
        </button>
      ) : (
        <div className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type what the couple should say…"
            className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            rows={2}
          />
          <div className="flex gap-3">
            <button
              onClick={() => say('primary')}
              disabled={busy}
              className="flex-1 bg-pink-600/80 hover:bg-pink-600 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg text-sm"
            >
              ▶ Speak as Margaret
            </button>
            <button
              onClick={() => say('spouse')}
              disabled={busy}
              className="flex-1 bg-blue-600/80 hover:bg-blue-600 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg text-sm"
            >
              ▶ Speak as Tom
            </button>
            <button
              onClick={stop}
              className="bg-navy-700 hover:bg-navy-600 text-slate-300 font-medium py-2.5 px-4 rounded-lg text-sm"
            >
              End
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
