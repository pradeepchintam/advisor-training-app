import { useState, useRef } from 'react';
import { ConversationProvider, useConversation } from '@elevenlabs/react';
import api from '../services/api';
import { useToast } from '../components/Toast';
import { getErrorMessage } from '../utils/errors';

/**
 * LOCAL TRIAL of ElevenLabs Conversational AI (Agents).
 *
 * Connects the browser directly to an ElevenLabs hosted agent (hosted Claude
 * + multi-voice) via a short-lived signed URL minted by our backend. The
 * agent roleplays a COUPLE, emitting <primary>/<spouse> voice tags so the
 * husband and wife come out in two distinct ElevenLabs voices in one session.
 *
 * This is isolated from the production cascade — purely to evaluate whether
 * the platform satisfies the couple + persona-control non-negotiables.
 */

type Turn = { source: string; text: string };

function TrialInner() {
  const toast = useToast();
  const [started, setStarted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [names, setNames] = useState<{ primary: string; spouse: string }>({
    primary: 'Margaret Smith',
    spouse: 'Tom Smith',
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const conversation = useConversation({
    onConnect: () => { setConnecting(false); setStarted(true); },
    onDisconnect: () => { setStarted(false); },
    onError: (e: unknown) => {
      setConnecting(false);
      toast.error(`Agent error: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
    },
    onMessage: (m: { message?: string; source?: string }) => {
      // m.source is "user" (advisor) or "ai" (the couple).
      if (!m?.message) return;
      setTurns((prev) => [...prev, { source: m.source || 'ai', text: m.message! }]);
      setTimeout(() => {
        transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
      }, 50);
    },
  });

  const start = async () => {
    setConnecting(true);
    setTurns([]);
    try {
      // Ask the mic permission up front (the SDK needs it).
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { data } = await api.post('/agent-trial/start', {
        primary_name: 'Margaret Smith',
        primary_gender: 'female',
        primary_personality: 'anxious and reserved',
        spouse_name: 'Tom Smith',
        spouse_gender: 'male',
        spouse_personality: 'analytical and cautious',
      });
      setNames({ primary: data.primary_name, spouse: data.spouse_name });
      conversation.startSession({ signedUrl: data.signed_url });
    } catch (err) {
      setConnecting(false);
      toast.error(`Couldn't start trial: ${getErrorMessage(err)}`);
    }
  };

  const stop = () => {
    try { conversation.endSession(); } catch { /* already stopped */ }
    setStarted(false);
  };

  const status = conversation.status; // 'connected' | 'connecting' | 'disconnected'
  const speaking = conversation.isSpeaking;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">ElevenLabs Agents — Couple Trial</h1>
        <p className="text-slate-500 mt-1 text-sm">
          Isolated spike: hosted Claude + multi-voice. The couple ({names.primary} &amp;{' '}
          {names.spouse}) responds in two distinct voices in one live session. Your
          production session flow is untouched.
        </p>
      </div>

      <div className="bg-navy-800 border border-navy-700 rounded-xl p-6 mb-6">
        <div className="flex items-center gap-4 mb-5">
          <div
            className={`w-3 h-3 rounded-full ${
              status === 'connected'
                ? speaking ? 'bg-gold-400 animate-pulse' : 'bg-green-500'
                : connecting ? 'bg-blue-500 animate-pulse' : 'bg-slate-600'
            }`}
          />
          <span className="text-slate-300 text-sm">
            {connecting
              ? 'Connecting…'
              : status === 'connected'
              ? speaking ? 'Couple is speaking…' : 'Listening — go ahead and talk'
              : 'Not connected'}
          </span>
        </div>

        {!started ? (
          <button
            onClick={start}
            disabled={connecting}
            className="w-full bg-gold-500 hover:bg-gold-400 disabled:opacity-60 text-navy-900 font-bold py-3 rounded-lg transition-colors"
          >
            {connecting ? 'Starting…' : 'Start Couple Conversation'}
          </button>
        ) : (
          <button
            onClick={stop}
            className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded-lg transition-colors"
          >
            End Conversation
          </button>
        )}
      </div>

      {/* Live transcript — shows source so you can see turn-taking. The
          actual two-voice effect is in the audio you hear. */}
      <div
        ref={transcriptRef}
        className="bg-navy-900 border border-navy-700 rounded-xl p-4 h-80 overflow-y-auto space-y-3"
      >
        {turns.length === 0 ? (
          <div className="text-slate-600 text-sm text-center mt-28">
            Transcript will appear here. Try: “Hi, what brings you both in today?”
            then “Tom, how do you feel about market risk?”
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={`flex ${t.source === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-md rounded-2xl px-3 py-2 text-sm ${
                  t.source === 'user'
                    ? 'bg-gold-500/20 border border-gold-500/30 text-white'
                    : 'bg-navy-800 text-slate-200'
                }`}
              >
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
                  {t.source === 'user' ? 'You (Advisor)' : 'Couple'}
                </div>
                {t.text}
              </div>
            </div>
          ))
        )}
      </div>

      <p className="text-slate-600 text-xs mt-3">
        Tip: open the browser console to watch the raw agent messages (including the
        <code className="mx-1">&lt;primary&gt;/&lt;spouse&gt;</code> voice tags Claude emits).
      </p>
    </div>
  );
}

export default function AgentTrial() {
  return (
    <ConversationProvider>
      <TrialInner />
    </ConversationProvider>
  );
}
