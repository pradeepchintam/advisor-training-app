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
  ready: 'Ready — Click mic to speak',
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

  // Slide deck state
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [currentSlide, setCurrentSlide] = useState(1);
  const [slideBlobUrl, setSlideBlobUrl] = useState<string | null>(null);
  const [slideLoading, setSlideLoading] = useState(false);

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

  // Fetch the active presentation once per session.
  useEffect(() => {
    presentationsApi.getActive()
      .then((p) => {
        setPresentation(p);
        setCurrentSlide(1);
      })
      .catch(() => setPresentation(null));
  }, []);

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
    setCurrentSlide(clamped);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'advisor_slide_change', slide_number: clamped }));
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
          const data = JSON.parse(evt.data as string) as { type: string; text?: string; message?: string };
          if (data.type === 'client_response' && data.text) {
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

    // Note: do NOT auto-stop the client's TTS playback here. The speaker's
    // audio should only be stopped when the user explicitly chooses to stop it.

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
      if (newFinal) {
        pendingTranscriptRef.current = (
          pendingTranscriptRef.current + ' ' + newFinal
        ).trim();
      }
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
              {/* Slide header */}
              <div className="px-5 py-3 border-b border-navy-700 flex items-center justify-between bg-navy-900">
                <div className="flex items-center gap-3">
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
            {session?.client_image_url ? (
              <img
                src={session.client_image_url}
                alt={session.client_name}
                className="w-10 h-10 rounded-full object-cover border border-navy-600 flex-shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-navy-700 border border-navy-600 flex items-center justify-center text-base font-bold text-gold-400 flex-shrink-0">
                {session?.client_name?.[0] ?? '?'}
              </div>
            )}
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

            {/* Two explicit talking controls. The advisor decides when to
                start and stop — the mic does NOT auto-cut on silence. */}
            <div className="flex items-center justify-center">
              {sessionStatus === 'listening' ? (
                <button
                  onClick={stopListening}
                  className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold px-8 py-3 rounded-lg text-base transition-all shadow-lg shadow-red-500/30"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop Talking
                </button>
              ) : (
                <button
                  onClick={startListening}
                  disabled={sessionStatus === 'processing' || sessionStatus === 'connecting' || sessionStatus === 'ended'}
                  className="flex items-center gap-2 bg-gold-500 hover:bg-gold-400 disabled:opacity-50 disabled:cursor-not-allowed text-navy-900 font-bold px-8 py-3 rounded-lg text-base transition-all shadow-lg shadow-gold-500/30"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                    <path d="M19 10v2a7 7 0 01-14 0v-2H3v2a9 9 0 008 8.94V23h2v-2.06A9 9 0 0021 12v-2h-2z" />
                  </svg>
                  Start Talking
                </button>
              )}
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
