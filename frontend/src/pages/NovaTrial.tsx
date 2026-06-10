import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast';

/**
 * LOCAL TRIAL of Amazon Nova Sonic — native speech-to-speech.
 *
 * Single client (no couple). The mic streams 16kHz PCM to the backend WS,
 * which forwards it to Nova Sonic; Nova streams the client's spoken reply
 * (24kHz PCM) + live transcripts back. No STT->LLM->TTS cascade.
 *
 * Persona is configurable: gender picks the Nova preset voice, name/age/
 * scenario steer the system prompt (Nova has no age voice dial).
 */

// ---- Minimal streaming PCM player (24kHz), shared-context safe ----
let _ctx: AudioContext | null = null;
function sharedCtx(): AudioContext {
  if (!_ctx || _ctx.state === 'closed') _ctx = new AudioContext();
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
  return _ctx;
}

class PCMPlayer {
  private ctx: AudioContext;
  private rate: number;
  private nextStart = 0;
  private active = true;
  private nodes: AudioBufferSourceNode[] = [];
  private leftover: Uint8Array | null = null;

  constructor(rate: number) {
    this.rate = rate;
    this.ctx = sharedCtx();
  }

  push(pcm: Uint8Array) {
    if (!this.active || pcm.byteLength === 0) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    let bytes = pcm;
    if (this.leftover && this.leftover.byteLength > 0) {
      const merged = new Uint8Array(this.leftover.byteLength + pcm.byteLength);
      merged.set(this.leftover, 0);
      merged.set(pcm, this.leftover.byteLength);
      bytes = merged;
      this.leftover = null;
    }
    const samples = bytes.byteLength >>> 1;
    const usableBytes = samples * 2;
    if (usableBytes < bytes.byteLength) this.leftover = bytes.slice(usableBytes);
    if (samples === 0) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
    const f32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, this.rate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const start = Math.max(this.ctx.currentTime + 0.05, this.nextStart);
    src.start(start);
    this.nodes.push(src);
    this.nextStart = start + buf.duration;
  }

  stop() {
    this.active = false;
    for (const n of this.nodes) {
      try { n.stop(); } catch { /* ended */ }
      try { n.disconnect(); } catch { /* noop */ }
    }
    this.nodes = [];
    this.leftover = null;
  }
}

type Turn = { role: 'advisor' | 'client'; text: string };

const AGES = [
  { value: 'young_adult', label: 'Young adult' },
  { value: 'middle_aged', label: 'Middle-aged' },
  { value: 'senior', label: 'Senior' },
  { value: 'elderly', label: 'Elderly' },
];

export default function NovaTrial() {
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [voice, setVoice] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [speaking, setSpeaking] = useState(false);

  // Persona form
  const [name, setName] = useState('Margaret');
  const [gender, setGender] = useState('female');
  const [age, setAge] = useState('senior');
  const [persona, setPersona] = useState(
    'Recently widowed, just sold a rental property and is nervous about ' +
    'investing the proceeds. Cares most about not outliving her savings.',
  );

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PCMPlayer | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  // Accumulate streamed assistant text into the latest client turn.
  const clientBufRef = useRef<string>('');

  const teardown = useCallback(() => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    wsRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    try { captureCtxRef.current?.close(); } catch { /* noop */ }
    captureCtxRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setConnected(false);
    setSpeaking(false);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = async () => {
    setConnecting(true);
    setTurns([]);
    try {
      // 1. Mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // 2. WebSocket
      const token = localStorage.getItem('auth_token') ?? '';
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        token, gender, age, name, persona,
      }).toString();
      const ws = new WebSocket(`${proto}//${window.location.host}/api/nova-trial/ws?${qs}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          // 24kHz client audio
          if (!playerRef.current) playerRef.current = new PCMPlayer(24000);
          playerRef.current.push(new Uint8Array(e.data));
          setSpeaking(true);
          return;
        }
        let msg: { type: string; text?: string; voice?: string };
        try { msg = JSON.parse(e.data as string); } catch { return; }
        if (msg.type === 'ready') {
          setVoice(msg.voice ?? '');
          setConnected(true);
          setConnecting(false);
        } else if (msg.type === 'user_transcript' && msg.text) {
          clientBufRef.current = '';
          setTurns((t) => [...t, { role: 'advisor', text: msg.text! }]);
        } else if (msg.type === 'assistant_text' && msg.text) {
          clientBufRef.current += msg.text;
          const full = clientBufRef.current;
          setTurns((t) => {
            const last = t[t.length - 1];
            if (last && last.role === 'client') {
              return [...t.slice(0, -1), { role: 'client', text: full }];
            }
            return [...t, { role: 'client', text: full }];
          });
        } else if (msg.type === 'interrupted') {
          // Barge-in: stop current playback so the client goes quiet.
          playerRef.current?.stop();
          playerRef.current = null;
          clientBufRef.current = '';
          setSpeaking(false);
        } else if (msg.type === 'turn_complete') {
          clientBufRef.current = '';
          setSpeaking(false);
        } else if (msg.type === 'error') {
          toast.error(`Nova: ${msg.text ?? 'error'}`);
        }
      };
      ws.onclose = () => { teardown(); };
      ws.onerror = () => { toast.error('WebSocket error'); };

      // 3. Mic capture worklet -> 16kHz PCM frames -> WS binary
      const ctx = new AudioContext();
      captureCtxRef.current = ctx;
      await ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture-worklet');
      node.port.onmessage = (ev) => {
        const sock = wsRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        try { sock.send(ev.data as unknown as ArrayBufferView); } catch { /* closed */ }
      };
      source.connect(node);
      // Do NOT connect node->destination (would echo the mic to speakers).
    } catch (err) {
      const e = err as Error;
      toast.error(`Couldn't start: ${e.message}`);
      setConnecting(false);
      teardown();
    }
  };

  const end = () => {
    try { wsRef.current?.send(JSON.stringify({ type: 'end' })); } catch { /* noop */ }
    teardown();
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Nova Sonic — Live Client (Trial)</h1>
        <p className="text-slate-500 mt-1 text-sm">
          Native speech-to-speech: just talk. The client hears you and replies out
          loud, powered end-to-end by Amazon Nova Sonic — no separate transcription
          or TTS step. Single client for this trial.
        </p>
      </div>

      {!connected ? (
        <div className="space-y-4 bg-navy-800 border border-navy-700 rounded-xl p-5">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-slate-300 text-sm">Client name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
              />
            </label>
            <label className="block">
              <span className="text-slate-300 text-sm">Gender (voice)</span>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="mt-1 w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
              >
                <option value="female">Female (Tiffany)</option>
                <option value="male">Male (Matthew)</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-slate-300 text-sm">Age / temperament (steers prompt)</span>
            <select
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="mt-1 w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            >
              {AGES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-slate-300 text-sm">Persona / scenario</span>
            <textarea
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={3}
              className="mt-1 w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gold-500"
            />
          </label>
          <button
            onClick={start}
            disabled={connecting}
            className="w-full bg-gold-500 hover:bg-gold-400 disabled:opacity-60 text-navy-900 font-bold py-3 rounded-lg transition-colors"
          >
            {connecting ? 'Connecting…' : 'Start Talking'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-navy-800 border border-navy-700 rounded-xl px-5 py-3">
            <div className="flex items-center gap-3">
              <span className={`inline-block w-3 h-3 rounded-full ${speaking ? 'bg-green-400 animate-pulse' : 'bg-slate-500'}`} />
              <span className="text-slate-200 text-sm">
                {speaking ? `${name} is speaking…` : `Listening — just talk to ${name}`}
              </span>
            </div>
            <span className="text-slate-500 text-xs">voice: {voice}</span>
          </div>

          <div className="bg-navy-900 border border-navy-700 rounded-xl p-4 h-80 overflow-y-auto space-y-3">
            {turns.length === 0 && (
              <p className="text-slate-600 text-sm text-center mt-8">
                Say hello to {name} to begin…
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === 'advisor' ? 'text-right' : 'text-left'}>
                <div className={`inline-block px-3 py-2 rounded-lg text-sm max-w-[80%] ${
                  t.role === 'advisor'
                    ? 'bg-blue-600/30 text-blue-100'
                    : 'bg-navy-700 text-slate-200'
                }`}>
                  <div className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">
                    {t.role === 'advisor' ? 'You (advisor)' : name}
                  </div>
                  {t.text}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={end}
            className="w-full bg-navy-700 hover:bg-navy-600 text-slate-200 font-medium py-2.5 rounded-lg text-sm"
          >
            End Session
          </button>
        </div>
      )}
    </div>
  );
}
