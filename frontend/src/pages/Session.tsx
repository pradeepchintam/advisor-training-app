import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sessionsApi, presentationsApi, ttsApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { getErrorMessage } from '../utils/errors';
import type { SessionDetail, ConversationMessage, Presentation } from '../types';

type SessionStatus = 'connecting' | 'ready' | 'listening' | 'processing' | 'client_speaking' | 'ended' | 'error';

const STATUS_LABEL: Record<SessionStatus, string> = {
  connecting: 'Connecting...',
  ready: 'Ready — mic on',
  listening: 'Listening...',
  processing: 'Processing...',
  client_speaking: 'Client is speaking...',
  ended: 'Session ended',
  error: 'Connection error',
};

const STATUS_COLOR: Record<SessionStatus, string> = {
  connecting: 'text-blue-400',
  ready: 'text-green-400',
  listening: 'text-red-400',
  processing: 'text-yellow-400',
  client_speaking: 'text-gold-400',
  ended: 'text-slate-500',
  error: 'text-red-500',
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Personality emoji used as a fallback when the photo isn't available.
const PERSONALITY_EMOJI: Record<string, string> = {
  anxious: '😰', confident: '😎', skeptical: '🤔', analytical: '🧐',
  emotional: '😢', impulsive: '😤', detail_oriented: '🤓', trusting: '😊',
};

/**
 * Animated client avatar — renders the persona photo with subtle "alive"
 * motion (breathing, periodic blink, head bob while speaking) and a
 * viseme-driven mouth overlay that pulses in time with the Polly audio.
 *
 * `mouthOpenness` is a 0..1 value driven by `audio.currentTime` against the
 * Polly viseme timeline; 0 = closed, 1 = wide open. When the client isn't
 * speaking the overlay disappears and the photo just gently breathes.
 *
 * Best results when the photo is a head-and-shoulders portrait. For random
 * stock photos the mouth overlay won't perfectly align with the photo's real
 * mouth, so we keep it small + glowy rather than trying to fake actual lips.
 */
function ClientAvatar({
  size,
  isSpeaking,
  personality,
  photoUrl,
  mouthOpenness,
}: {
  size: number;
  isSpeaking: boolean;
  personality?: string;
  photoUrl?: string | null;
  mouthOpenness?: number;
}) {
  const openness = Math.max(0, Math.min(1, mouthOpenness ?? 0));
  const mouthW = 0.22 + openness * 0.10; // 22%..32% of avatar width
  const mouthH = 0.03 + openness * 0.13; // 3%..16% of avatar height
  const fallbackEmoji = PERSONALITY_EMOJI[personality ?? ''] ?? '😐';

  return (
    <div
      className="relative flex-shrink-0 select-none"
      style={{ width: size, height: size }}
    >
      {/* Pulsing gold ring while speaking */}
      {isSpeaking && (
        <span className="absolute -inset-1 rounded-full ring-2 ring-gold-400/70 animate-pulse pointer-events-none" />
      )}

      {/* Photo / fallback emoji — always breathing, gentle head-bob when speaking */}
      <div
        className="absolute inset-0 rounded-full overflow-hidden bg-navy-700 border border-navy-600 flex items-center justify-center"
        style={{
          animation: isSpeaking
            ? 'avatar-breathe 2.4s ease-in-out infinite, avatar-bob 800ms ease-in-out infinite'
            : 'avatar-breathe 3.2s ease-in-out infinite',
        }}
      >
        {photoUrl ? (
          <img
            src={photoUrl}
            alt="client"
            className="w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="leading-none" style={{ fontSize: size * 0.7 }}>{fallbackEmoji}</span>
        )}

        {/* Blink overlay — thin dark band across the upper face every few seconds */}
        <span
          className="absolute left-0 right-0 bg-navy-950 pointer-events-none"
          style={{
            top: '32%',
            height: '8%',
            animation: 'avatar-blink 5.3s steps(1, end) infinite',
            opacity: 0,
          }}
        />

        {/* Viseme-driven mouth overlay. Small dark oval with a soft gold glow
            that scales with the current viseme's openness. Positioned at ~62%
            Y — roughly where headshots have the mouth. */}
        {isSpeaking && (
          <div
            className="absolute left-1/2 pointer-events-none"
            style={{
              top: '62%',
              transform: `translate(-50%, -50%)`,
              width: `${mouthW * 100}%`,
              height: `${mouthH * 100}%`,
              transition: 'width 70ms linear, height 70ms linear',
            }}
          >
            <div
              className="w-full h-full rounded-full"
              style={{
                background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.78) 35%, rgba(0,0,0,0.0) 85%)',
                boxShadow: `0 0 ${12 + openness * 18}px ${4 + openness * 8}px rgba(250, 204, 21, ${0.18 + openness * 0.30})`,
              }}
            />
          </div>
        )}
      </div>

      {/* Inline keyframes so this component is self-contained. */}
      <style>{`
        @keyframes avatar-breathe {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.015); }
        }
        @keyframes avatar-bob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-1.5px); }
        }
        @keyframes avatar-blink {
          0%, 92%  { opacity: 0; }
          93%, 96% { opacity: 0.82; }
          97%, 100%{ opacity: 0; }
        }
      `}</style>
    </div>
  );
}

// Map Polly viseme codes to mouth openness 0..1.
const VISEME_OPENNESS: Record<string, number> = {
  sil: 0, p: 0, t: 0.18, S: 0.28, T: 0.20, f: 0.15, k: 0.28,
  i: 0.40, r: 0.32, s: 0.22, u: 0.42, '@': 0.50,
  a: 0.88, e: 0.42, E: 0.45, o: 0.58, O: 0.72,
};

function visemeOpennessOf(value: string | undefined): number {
  if (!value) return 0;
  return VISEME_OPENNESS[value] ?? 0.3;
}

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('connecting');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isVideoRecording, setIsVideoRecording] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [interimText, setInterimText] = useState('');

  // Slide deck state. A session may have one deck (1st/2nd appt) or two
  // (3rd appt: Annuity + Private Equity) shown as tabs.
  const [decks, setDecks] = useState<Presentation[]>([]);
  const [activeDeckIndex, setActiveDeckIndex] = useState(0);
  const [slidePerDeck, setSlidePerDeck] = useState<Record<string, number>>({});
  const [slideBlobUrl, setSlideBlobUrl] = useState<string | null>(null);
  const [slideLoading, setSlideLoading] = useState(false);

  const presentation = decks[activeDeckIndex] ?? null;
  const currentSlide = presentation ? (slidePerDeck[presentation.id] ?? 1) : 1;

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const endingRef = useRef(false);
  // Buffer of finalized speech segments accumulated since the advisor pressed
  // "Start Talking". Sent in one message when they press "Stop Talking".
  const pendingTranscriptRef = useRef<string>('');
  // True between Start Talking and Stop Talking — even across mid-utterance
  // silences. Used to keep the mic UI in "listening" state without relying on
  // the browser's auto end-of-speech events.
  const isTalkingRef = useRef(false);

  // ---- Streaming client response + sentence-level TTS queue --------------
  // Full text accumulated for the message being streamed in.
  const streamFullRef = useRef('');
  // Text not yet split into sentences for the TTS queue.
  const unspokenBufRef = useRef('');
  // True while we're between client_response_start and client_response_end.
  const streamingRef = useRef(false);
  // Sentence queue (text fragments) + a one-at-a-time playback gate.
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  // Index of the live in-progress client bubble in `messages`.
  const streamMsgIndexRef = useRef<number | null>(null);

  // ---- Always-on interactive mic ----------------------------------------
  // The mic is hot for the entire session. VAD silence-debounce auto-sends
  // each utterance; the advisor can optionally Mute to take a phone call.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Avatar mouth overlay driven by Polly visemes ----------------------
  const [mouthOpenness, setMouthOpenness] = useState(0);
  const currentVisemesRef = useRef<import('../services/api').VisemeMark[]>([]);
  const visemeRafRef = useRef<number | null>(null);

  // Scroll transcript to bottom
  const scrollTranscript = useCallback(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollTranscript();
  }, [messages, scrollTranscript]);

  // Load session
  useEffect(() => {
    if (!id) return;
    sessionsApi.get(id).then((s) => {
      setSession(s);
      if (s.conversation?.length) {
        setMessages(s.conversation);
      }
    }).catch((err) => {
      toast.error(`Failed to load session: ${getErrorMessage(err)}`);
      setSessionStatus('error');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Timer
  useEffect(() => {
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Helper: stop any in-flight TTS audio and free its blob URL.
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* ignored */ }
      const src = audioRef.current.src;
      audioRef.current = null;
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
    }
  }, []);

  // Cleanup on unmount — stop camera/mic + audio even if user navigates away
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
      isTalkingRef.current = false;
      try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
      stopAudio();
    };
  }, [stopAudio]);

  // Fetch the deck(s) for THIS session based on its appointment type.
  // Third appointments return two decks (Annuity + Private Equity).
  useEffect(() => {
    if (!id) return;
    sessionsApi.presentations(id)
      .then((list) => {
        setDecks(list);
        setActiveDeckIndex(0);
        setSlidePerDeck(Object.fromEntries(list.map((d) => [d.id, 1])));
      })
      .catch(() => setDecks([]));
  }, [id]);

  // Whenever the slide number changes (or the deck loads), fetch that slide's PNG.
  useEffect(() => {
    if (!presentation) return;
    let cancelled = false;
    setSlideLoading(true);
    presentationsApi.fetchSlideBlob(presentation.id, currentSlide)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setSlideBlobUrl((prev) => {
          if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch(() => { /* swallow — UI shows fallback */ })
      .finally(() => { if (!cancelled) setSlideLoading(false); });
    return () => { cancelled = true; };
  }, [presentation, currentSlide]);

  // Revoke the slide blob URL on unmount.
  useEffect(() => {
    return () => {
      if (slideBlobUrl && slideBlobUrl.startsWith('blob:')) URL.revokeObjectURL(slideBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigate to a slide and notify the backend so the analysis can track timing.
  const goToSlide = useCallback((n: number) => {
    if (!presentation) return;
    const clamped = Math.max(1, Math.min(presentation.slide_count, n));
    if (clamped === currentSlide) return;
    setSlidePerDeck((prev) => ({ ...prev, [presentation.id]: clamped }));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'advisor_slide_change',
        slide_number: clamped,
        presentation_id: presentation.id,
        deck_label: presentation.slot_label ?? presentation.title,
      }));
    }
  }, [presentation, currentSlide]);

  // Speak text via AWS Polly (server-side). Returns when audio playback ends.
  const speak = useCallback(
    async (text: string) => {
      stopAudio();
      try {
        setSessionStatus('client_speaking');
        const url = await ttsApi.synthesize(text, session?.persona?.gender as ('male' | 'female' | undefined));
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          stopAudio();
          setSessionStatus('ready');
        };
        audio.onerror = () => {
          stopAudio();
          setSessionStatus('ready');
        };
        await audio.play();
      } catch (err) {
        stopAudio();
        toast.error(`TTS error: ${getErrorMessage(err)}`);
        setSessionStatus('ready');
      }
    },
    [session?.persona?.gender, stopAudio, toast]
  );

  // ---- Sentence-level streaming TTS --------------------------------------
  // Synthesize and play one sentence; recurses to drain the queue. Keeps the
  // session in 'client_speaking' state until the queue empties AND the server
  // stream has ended.
  const playNextSentence = useCallback(async () => {
    if (ttsPlayingRef.current) return;
    const next = ttsQueueRef.current.shift();
    if (!next) {
      if (!streamingRef.current) setSessionStatus('ready');
      return;
    }
    ttsPlayingRef.current = true;
    let blobUrl: string | null = null;
    const gender = session?.persona?.gender as ('male' | 'female' | undefined);
    try {
      setSessionStatus('client_speaking');
      // Fetch audio + visemes in parallel — viseme timing drives the mouth
      // overlay; if the marks call fails, we just degrade to a static mouth.
      const [url, marks] = await Promise.all([
        ttsApi.synthesize(next, gender),
        ttsApi.marks(next, gender),
      ]);
      blobUrl = url;
      currentVisemesRef.current = (marks || []).filter((m) => m.type === 'viseme');

      const audio = new Audio(blobUrl);
      audioRef.current = audio;

      // requestAnimationFrame loop: look up the current viseme by elapsed time
      // and translate it into mouth openness for the overlay.
      const tick = () => {
        if (audioRef.current !== audio) {
          visemeRafRef.current = null;
          return;
        }
        const tMs = audio.currentTime * 1000;
        const list = currentVisemesRef.current;
        // Binary-ish search; lists are short (~30-100 marks per sentence).
        let lo = 0, hi = list.length - 1, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].time <= tMs) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        const v = idx >= 0 ? list[idx].value : undefined;
        setMouthOpenness(visemeOpennessOf(v));
        visemeRafRef.current = requestAnimationFrame(tick);
      };
      visemeRafRef.current = requestAnimationFrame(tick);

      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
      if (audioRef.current === audio) audioRef.current = null;
    } catch (err) {
      console.warn('TTS sentence failed:', err);
    } finally {
      if (visemeRafRef.current != null) {
        cancelAnimationFrame(visemeRafRef.current);
        visemeRafRef.current = null;
      }
      setMouthOpenness(0);
      if (blobUrl && blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
      ttsPlayingRef.current = false;
      // Continue draining; if interrupted, the queue was cleared so this exits.
      if (ttsQueueRef.current.length > 0) {
        void playNextSentence();
      } else if (!streamingRef.current) {
        setSessionStatus('ready');
      }
    }
  }, [session?.persona?.gender]);

  const enqueueSentences = useCallback((sentences: string[]) => {
    if (sentences.length === 0) return;
    ttsQueueRef.current.push(...sentences);
    if (!ttsPlayingRef.current) void playNextSentence();
  }, [playNextSentence]);

  // Extract every complete sentence currently in unspokenBufRef and enqueue
  // them. Partial trailing text is kept in the buffer for the next chunk.
  const drainCompleteSentences = useCallback(() => {
    let buf = unspokenBufRef.current;
    const out: string[] = [];
    const re = /^([\s\S]*?[.!?]+["')\]]?)(\s+)/;
    while (true) {
      const m = buf.match(re);
      if (!m) break;
      const sentence = m[1].trim();
      if (sentence) out.push(sentence);
      buf = buf.slice(m[0].length);
    }
    unspokenBufRef.current = buf;
    enqueueSentences(out);
  }, [enqueueSentences]);

  const handleClientStart = useCallback((timestamp: string) => {
    streamingRef.current = true;
    streamFullRef.current = '';
    unspokenBufRef.current = '';
    setSessionStatus('client_speaking');
    setMessages((prev) => {
      const next = [
        ...prev,
        { role: 'client' as const, text: '', timestamp: timestamp || new Date().toISOString() },
      ];
      streamMsgIndexRef.current = next.length - 1;
      return next;
    });
  }, []);

  const handleClientChunk = useCallback((chunk: string) => {
    if (!chunk) return;
    streamFullRef.current += chunk;
    unspokenBufRef.current += chunk;
    setMessages((prev) => {
      const idx = streamMsgIndexRef.current;
      if (idx == null || idx < 0 || idx >= prev.length) return prev;
      const out = prev.slice();
      out[idx] = { ...out[idx], text: streamFullRef.current };
      return out;
    });
    drainCompleteSentences();
  }, [drainCompleteSentences]);

  const handleClientEnd = useCallback((fullText: string, timestamp: string) => {
    streamingRef.current = false;
    // Reconcile the live bubble with the server's authoritative text.
    setMessages((prev) => {
      const idx = streamMsgIndexRef.current;
      if (idx == null || idx < 0 || idx >= prev.length) return prev;
      const out = prev.slice();
      out[idx] = { ...out[idx], text: fullText, timestamp: timestamp || out[idx].timestamp };
      return out;
    });
    streamMsgIndexRef.current = null;
    // Flush any trailing partial as the final sentence.
    const tail = unspokenBufRef.current.trim();
    unspokenBufRef.current = '';
    streamFullRef.current = '';
    if (tail) enqueueSentences([tail]);
    // If nothing is left to play, return to ready immediately.
    if (ttsQueueRef.current.length === 0 && !ttsPlayingRef.current) {
      setSessionStatus('ready');
    }
  }, [enqueueSentences]);

  // MediaRecorder setup
  const startRecording = useCallback(async () => {
    try {
      let stream: MediaStream;
      let mimeType = 'audio/webm';
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setIsVideoRecording(true);
        mimeType = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'audio/webm';
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setIsVideoRecording(false);
        mimeType = 'audio/webm';
      }

      mediaStreamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.start(10000); // collect chunks every 10s
      setIsRecording(true);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const explain: Record<string, string> = {
        NotAllowedError: 'Camera/microphone permission denied. Click the camera icon in your browser address bar to allow access.',
        NotFoundError: 'No camera or microphone found on this device.',
        NotReadableError: 'Camera/microphone is in use by another application.',
        OverconstrainedError: 'No camera/microphone matches the required constraints.',
        SecurityError: 'Recording blocked by browser security policy. Try HTTPS or localhost.',
      };
      const friendly = explain[e.name || ''] || e.message || 'Unknown error';
      console.warn('Recording not available:', err);
      toast.error(`Recording disabled — ${friendly}`);
    }
  }, [toast]);

  // WebSocket setup — defer creation to next tick so StrictMode's double-invoke
  // can cancel the first attempt before the socket actually opens.
  useEffect(() => {
    if (!id || !token) return;
    let cancelled = false;
    let ws: WebSocket | null = null;

    const timer = setTimeout(() => {
      if (cancelled) return;

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/session/${id}?token=${token}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        setSessionStatus('ready');
        startRecording();
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data as string) as {
            type: string; text?: string; message?: string; timestamp?: string;
          };
          if (data.type === 'client_response_start') {
            handleClientStart(data.timestamp || '');
          } else if (data.type === 'client_response_chunk' && data.text) {
            handleClientChunk(data.text);
          } else if (data.type === 'client_response_end' && typeof data.text === 'string') {
            handleClientEnd(data.text, data.timestamp || '');
          } else if (data.type === 'client_response' && data.text) {
            // Legacy non-streaming path — used by older servers / replays.
            const msg: ConversationMessage = {
              role: 'client',
              text: data.text,
              timestamp: new Date().toISOString(),
            };
            setMessages((prev) => [...prev, msg]);
            speak(data.text);
          } else if (data.type === 'error') {
            toast.error(data.message || 'Session error');
            setSessionStatus('error');
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        setSessionStatus('error');
        toast.error(
          'WebSocket connection failed. Check that the backend is running on port 8000 ' +
          'and that your auth token is still valid. See browser console for details.'
        );
      };

      ws.onclose = () => {
        if (cancelled || endingRef.current) return;
        setSessionStatus('error');
      };
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);

  // Speak first client message on load if conversation already has messages
  useEffect(() => {
    if (messages.length === 1 && messages[0].role === 'client') {
      setTimeout(() => speak(messages[0].text), 800);
    }
  }, [messages, speak]);

  // Speech Recognition
  const startListening = useCallback(() => {
    const SR = (window as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
      (window as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) {
      toast.error('Speech recognition not supported in this browser. Use text input.');
      return;
    }

    // Barge-in: pressing Start Talking while the client is speaking counts
    // as the advisor explicitly choosing to interject, so cut off the
    // client's TTS immediately. (Dedicated "Interrupt" button below stops
    // the audio without opening the mic.)
    stopAudio();

    const recognition = new SR();
    recognitionRef.current = recognition;
    // continuous=true keeps the recognizer alive across pauses so the advisor
    // can think mid-sentence without the browser auto-ending the utterance.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    pendingTranscriptRef.current = '';
    isTalkingRef.current = true;
    setSessionStatus('listening');
    setInterimText('');

    recognition.onresult = (evt: SpeechRecognitionEvent) => {
      let interim = '';
      let newFinal = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const t = evt.results[i][0].transcript;
        if (evt.results[i].isFinal) newFinal += t;
        else interim += t;
      }
      // Auto barge-in: the moment the advisor's voice produces ANY transcript
      // text while the client is still talking, silence the TTS queue. This
      // is the half-duplex stand-in for native audio-level interruption — it
      // gets the "real-time feel" without the AudioWorklet+Transcribe lift.
      const hasNewSpeech = newFinal.trim().length > 0 || interim.trim().length > 0;
      if (hasNewSpeech && (ttsPlayingRef.current || ttsQueueRef.current.length > 0)) {
        ttsQueueRef.current = [];
        unspokenBufRef.current = '';
        stopAudio();
        if (visemeRafRef.current != null) {
          cancelAnimationFrame(visemeRafRef.current);
          visemeRafRef.current = null;
        }
        setMouthOpenness(0);
        setSessionStatus('listening');
      }
      if (newFinal) {
        pendingTranscriptRef.current = (
          pendingTranscriptRef.current + ' ' + newFinal
        ).trim();
      }
      // Silence-debounce VAD: 2.5s of no new transcript activity auto-sends
      // the accumulated text. Any new final/interim resets the timer.
      if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
      vadTimerRef.current = setTimeout(() => {
        const finalText = pendingTranscriptRef.current.trim();
        pendingTranscriptRef.current = '';
        setInterimText('');
        vadTimerRef.current = null;
        if (finalText) sendAdvisorMessage(finalText);
      }, 2500);
      // Show pending + interim live so the advisor can see what's captured so far.
      setInterimText(
        (pendingTranscriptRef.current + (interim ? ' ' + interim : '')).trim()
      );
    };

    recognition.onerror = (evt: SpeechRecognitionErrorEvent) => {
      // 'no-speech' fires when the advisor pauses; we don't want that to end
      // the session — they may still be thinking. Only surface real errors.
      const ignorable = evt.error === 'aborted' || evt.error === 'no-speech';
      if (!ignorable) {
        const explain: Record<string, string> = {
          'audio-capture': 'Microphone not available — check browser permissions',
          'not-allowed': 'Microphone permission denied — allow access in your browser settings',
          'network': 'Network error in speech recognition service',
          'service-not-allowed': 'Speech recognition blocked by browser policy',
          'bad-grammar': 'Speech recognition grammar error',
          'language-not-supported': 'Speech recognition language not supported',
        };
        const detail = explain[evt.error] || evt.error;
        toast.error(`Microphone error (${evt.error}): ${detail}${evt.message ? ` — ${evt.message}` : ''}`);
        isTalkingRef.current = false;
        setSessionStatus('ready');
        setInterimText('');
      }
      // Otherwise the browser will fire onend right after; we re-arm there.
    };

    recognition.onend = () => {
      // If the advisor still wants to be talking (hasn't pressed Stop yet),
      // re-arm the recognizer. Some browsers end the session at the first long
      // pause even when continuous=true.
      if (isTalkingRef.current) {
        try { recognition.start(); } catch { /* already running */ }
        return;
      }
      setInterimText('');
    };

    try {
      recognition.start();
    } catch {
      // start() can throw "InvalidStateError" if the recognizer is already
      // running from a previous re-arm — safe to ignore.
    }
  }, [toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mute / unmute toggle — temporarily silences the mic (e.g., advisor needs
  // to take a phone call). The interactive default is mic-on for the whole
  // session; this gives an emergency off-switch.
  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      if (next) {
        if (vadTimerRef.current) {
          clearTimeout(vadTimerRef.current);
          vadTimerRef.current = null;
        }
        isTalkingRef.current = false;
        try { recognitionRef.current?.stop(); } catch { /* ignored */ }
        pendingTranscriptRef.current = '';
        setInterimText('');
        setSessionStatus('ready');
      } else {
        // Re-open the mic immediately.
        setTimeout(() => startListening(), 0);
      }
      return next;
    });
  }, [startListening]);

  // Auto-open the mic whenever we're ready and not muted. This is what makes
  // every session "interactive by default" — no Start button needed.
  useEffect(() => {
    if (mutedRef.current) return;
    if (sessionStatus !== 'ready') return;
    if (recognitionRef.current && isTalkingRef.current) return;
    const t = setTimeout(() => {
      if (!mutedRef.current && sessionStatus === 'ready') startListening();
    }, 150);
    return () => clearTimeout(t);
  }, [sessionStatus, startListening]);

  // Silence the client without opening the mic — pure "shush" control.
  // Clears the entire sentence-level TTS queue so no further audio plays
  // even if more chunks are still streaming in from the server.
  const interruptClient = useCallback(() => {
    ttsQueueRef.current = [];
    unspokenBufRef.current = '';
    stopAudio();
    if (visemeRafRef.current != null) {
      cancelAnimationFrame(visemeRafRef.current);
      visemeRafRef.current = null;
    }
    setMouthOpenness(0);
    setSessionStatus('ready');
  }, [stopAudio]);

  const stopListening = useCallback(() => {
    // Tell the re-arm guard to NOT restart recognition on onend.
    isTalkingRef.current = false;
    try { recognitionRef.current?.stop(); } catch { /* ignored */ }
    const finalText = pendingTranscriptRef.current.trim();
    pendingTranscriptRef.current = '';
    setInterimText('');
    if (finalText) {
      sendAdvisorMessage(finalText);
    } else {
      setSessionStatus('ready');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendAdvisorMessage = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      const msg: ConversationMessage = {
        role: 'advisor',
        text: text.trim(),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, msg]);
      setSessionStatus('processing');

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'advisor_message', text: text.trim() }));
      } else {
        const stateMap: Record<number, string> = {
          0: 'still connecting (CONNECTING)',
          1: 'open (OPEN)',
          2: 'closing (CLOSING)',
          3: 'closed (CLOSED)',
        };
        const state = wsRef.current ? stateMap[wsRef.current.readyState] : 'not initialized';
        toast.error(
          `Cannot send message — WebSocket is ${state}. ` +
          `This usually means the session ended, the backend restarted, or your auth token expired. ` +
          `Please refresh the page to reconnect.`
        );
        setSessionStatus('error');
      }
    },
    [toast]
  );

  const handleEndSession = async () => {
    setIsEnding(true);
    endingRef.current = true;
    setShowEndConfirm(false);

    // Stop camera/mic immediately — before any async work that might throw,
    // so the browser indicator light always turns off.
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    const wasVideoRecording = isVideoRecording;
    setIsRecording(false);
    setIsVideoRecording(false);

    try {
      // Stop speech
      stopAudio();
      isTalkingRef.current = false;
      recognitionRef.current?.stop();

      // Stop recording & upload
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          mediaRecorderRef.current!.onstop = () => resolve();
          mediaRecorderRef.current!.stop();
        });

        if (chunksRef.current.length > 0 && id) {
          const mimeType = wasVideoRecording ? 'video/webm' : 'audio/webm';
          const blob = new Blob(chunksRef.current, { type: mimeType });
          try {
            await sessionsApi.uploadRecording(id, blob);
            toast.success('Recording uploaded');
          } catch (uploadErr) {
            toast.warning(`Recording upload failed: ${getErrorMessage(uploadErr)} — continuing anyway`);
          }
        }
      }

      // Close WS
      if (wsRef.current) {
        try {
          wsRef.current.send(JSON.stringify({ type: 'end_session' }));
        } catch { /* ignore */ }
        wsRef.current.close();
      }

      // End session → trigger analysis, then back to dashboard
      if (id) {
        await sessionsApi.end(id);
        toast.success('Session ended. Analysis will be available shortly on your dashboard.');
        navigate('/dashboard');
      }
    } catch (err) {
      console.error('End session error:', err);
      toast.error(`Failed to end session: ${getErrorMessage(err)}`);
      setIsEnding(false);
    }
  };

  const persona = session?.persona;

  return (
    <div className="flex flex-col h-screen bg-navy-900">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-6 py-3 bg-navy-800 border-b border-navy-700 flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="text-gold-400 font-bold text-sm">
            {session?.client_name ?? 'Loading...'}
          </div>
          <div className="flex items-center gap-1.5 bg-navy-900 px-3 py-1 rounded-full">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-slate-500">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
            </svg>
            <span className="text-slate-400 text-xs font-mono">{formatTime(elapsedSeconds)}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Recording indicator */}
          {isRecording && (
            <div className="flex items-center gap-1.5 bg-red-900/40 border border-red-800 px-3 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 text-xs font-semibold">
                {isVideoRecording ? 'VIDEO REC' : 'AUDIO REC'}
              </span>
            </div>
          )}

          <button
            onClick={() => setShowEndConfirm(true)}
            disabled={isEnding}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-semibold px-4 py-1.5 rounded-lg text-sm transition-colors"
          >
            {isEnding ? 'Ending...' : 'End Session'}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: Slide Pane (60%) */}
        <div className="flex-1 bg-navy-950 border-r border-navy-700 flex flex-col min-w-0">
          {presentation ? (
            <>
              {/* Deck tabs — shown when the session has more than one deck
                  (3rd appointment: Annuity + Private Equity). */}
              {decks.length > 1 && (
                <div className="flex gap-1 px-5 pt-3 bg-navy-900">
                  {decks.map((d, i) => (
                    <button
                      key={d.id}
                      onClick={() => setActiveDeckIndex(i)}
                      className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
                        i === activeDeckIndex
                          ? 'bg-navy-950 text-gold-400 border-x border-t border-navy-700'
                          : 'bg-navy-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {d.slot_label ?? d.title}
                    </button>
                  ))}
                </div>
              )}

              {/* Slide header */}
              <div className="px-5 py-3 border-b border-navy-700 flex items-center justify-between bg-navy-900">
                <div className="flex items-center gap-3">
                  {decks.length > 1 && presentation.slot_label && (
                    <span className="text-gold-400 text-xs font-semibold uppercase tracking-wider">{presentation.slot_label}</span>
                  )}
                  <span className="text-slate-300 text-sm font-semibold truncate max-w-md">{presentation.title}</span>
                  <span className="text-slate-500 text-xs">v{presentation.version}</span>
                </div>
                <div className="text-slate-400 text-sm font-mono">
                  Slide {currentSlide} / {presentation.slide_count}
                </div>
              </div>

              {/* Slide image */}
              <div className="flex-1 flex items-center justify-center p-6 overflow-hidden">
                {slideBlobUrl ? (
                  <img
                    src={slideBlobUrl}
                    alt={`Slide ${currentSlide}`}
                    className={`max-w-full max-h-full object-contain rounded-lg shadow-2xl transition-opacity ${slideLoading ? 'opacity-50' : 'opacity-100'}`}
                  />
                ) : (
                  <div className="text-slate-600 text-sm">Loading slide…</div>
                )}
              </div>

              {/* Slide nav */}
              <div className="px-5 py-3 border-t border-navy-700 bg-navy-900 flex items-center justify-between gap-3">
                <button
                  onClick={() => goToSlide(currentSlide - 1)}
                  disabled={currentSlide <= 1}
                  className="px-4 py-2 bg-navy-700 hover:bg-navy-600 disabled:opacity-30 disabled:cursor-not-allowed text-slate-200 rounded-lg text-sm transition-colors"
                >
                  ← Prev
                </button>
                <div className="flex gap-1 flex-1 justify-center overflow-x-auto">
                  {Array.from({ length: presentation.slide_count }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      onClick={() => goToSlide(n)}
                      className={`w-7 h-7 rounded text-xs font-semibold flex-shrink-0 transition-colors ${
                        n === currentSlide ? 'bg-gold-500 text-navy-900' : 'bg-navy-700 text-slate-400 hover:bg-navy-600 hover:text-slate-200'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => goToSlide(currentSlide + 1)}
                  disabled={currentSlide >= presentation.slide_count}
                  className="px-4 py-2 bg-navy-700 hover:bg-navy-600 disabled:opacity-30 disabled:cursor-not-allowed text-slate-200 rounded-lg text-sm transition-colors"
                >
                  Next →
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <div className="text-5xl mb-4">📊</div>
              <div className="text-slate-400 font-medium mb-1">No active presentation</div>
              <div className="text-slate-600 text-sm max-w-md">
                Ask an admin to upload a slide deck in <span className="text-gold-400">Admin → Presentation</span> to walk your client through it during this session.
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: Advisor Panel (40%) */}
        <div className="w-[40%] min-w-[420px] flex flex-col">
          {/* Compact client header */}
          <div className="px-4 py-3 border-b border-navy-700 bg-navy-800 flex items-center gap-3">
            <ClientAvatar
              size={56}
              isSpeaking={sessionStatus === 'client_speaking'}
              personality={persona?.personality_type}
              photoUrl={session?.client_image_url ?? null}
              mouthOpenness={mouthOpenness}
            />
            <div className="flex-1 min-w-0">
              <div className="text-white text-sm font-semibold truncate">{session?.client_name}</div>
              {persona && (
                <div className="text-slate-500 text-xs truncate">
                  {persona.age_group.replace('_', ' ')} · {persona.personality_type.replace('_', ' ')} · {(persona.primary_concerns ?? []).join(', ')}
                </div>
              )}
            </div>
          </div>
          {/* Conversation transcript */}
          <div ref={transcriptRef} className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="text-4xl mb-3">🎙️</div>
                  <div className="text-slate-500">Connecting to session...</div>
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${msg.role === 'advisor' ? 'flex-row-reverse' : ''}`}
              >
                {/* Avatar */}
                <div
                  className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                    msg.role === 'client'
                      ? 'bg-navy-700 text-gold-400'
                      : 'bg-gold-500 text-navy-900'
                  }`}
                >
                  {msg.role === 'client' ? session?.client_name?.[0] ?? 'C' : 'A'}
                </div>

                {/* Bubble */}
                <div
                  className={`max-w-lg rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'client'
                      ? 'bg-navy-800 text-slate-200 rounded-tl-sm'
                      : 'bg-gold-500/20 border border-gold-500/30 text-white rounded-tr-sm'
                  }`}
                >
                  <div className="text-xs text-slate-600 mb-1 font-medium">
                    {msg.role === 'client' ? session?.client_name ?? 'Client' : 'You (Advisor)'}
                  </div>
                  {msg.text}
                </div>
              </div>
            ))}

            {/* Interim speech text */}
            {interimText && (
              <div className="flex gap-3 flex-row-reverse">
                <div className="w-8 h-8 rounded-full bg-gold-500 text-navy-900 flex-shrink-0 flex items-center justify-center text-xs font-bold">
                  A
                </div>
                <div className="max-w-lg rounded-2xl px-4 py-3 bg-gold-500/10 border border-gold-500/20 text-slate-400 text-sm italic">
                  {interimText}...
                </div>
              </div>
            )}

            {sessionStatus === 'processing' && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-navy-700 text-gold-400 flex-shrink-0 flex items-center justify-center text-xs font-bold">
                  {session?.client_name?.[0] ?? 'C'}
                </div>
                <div className="bg-navy-800 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1">
                  <span className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
          </div>

          {/* Voice interface */}
          <div className="border-t border-navy-700 bg-navy-800 p-5">
            {/* Status indicator */}
            <div className="flex items-center justify-center mb-4">
              <span className={`text-sm font-medium ${STATUS_COLOR[sessionStatus]}`}>
                {STATUS_LABEL[sessionStatus]}
              </span>
            </div>

            {/* Interactive by default — the mic is hot for the whole session.
                The only controls are an Interrupt (while the client is talking)
                and a Mute toggle for when the advisor needs to step away. */}
            <div className="flex items-center justify-center gap-3">
              {sessionStatus === 'client_speaking' && (
                <button
                  onClick={interruptClient}
                  className="flex items-center gap-2 bg-red-700/80 hover:bg-red-700 text-white font-semibold px-5 py-3 rounded-lg text-sm transition-all border border-red-500/50"
                  title="Stop the client's audio"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                    <path d="M6 6h12v12H6z" />
                  </svg>
                  Interrupt
                </button>
              )}
              <button
                onClick={toggleMute}
                disabled={sessionStatus === 'connecting' || sessionStatus === 'ended'}
                title={muted ? 'Re-open your mic' : 'Mute your mic temporarily'}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors border ${
                  muted
                    ? 'bg-red-900/40 border-red-700 text-red-300 hover:bg-red-900/60'
                    : 'bg-navy-700 border-navy-600 text-slate-200 hover:bg-navy-600'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {muted ? '🔇 Muted — click to unmute' : '🎙️ Mute mic'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* End Session Confirmation */}
      <ConfirmModal
        isOpen={showEndConfirm}
        title="End Training Session?"
        message="This will stop the recording, upload it, and trigger AI analysis of your session. The analysis may take a minute to complete."
        confirmLabel="End & Analyze"
        cancelLabel="Continue Session"
        confirmClassName="bg-red-600 hover:bg-red-700 text-white"
        onConfirm={handleEndSession}
        onCancel={() => setShowEndConfirm(false)}
      />
    </div>
  );
}
