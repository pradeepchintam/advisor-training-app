import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sessionsApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { getErrorMessage } from '../utils/errors';
import type { SessionDetail, ConversationMessage } from '../types';

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
  const [textInput, setTextInput] = useState('');
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [interimText, setInterimText] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const endingRef = useRef(false);

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

  // Cleanup on unmount — stop camera/mic even if user navigates away
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
      try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
      speechSynthesis.cancel();
    };
  }, []);

  // Pick synth voice for client based on persona gender
  useEffect(() => {
    const pickVoice = () => {
      const voices = speechSynthesis.getVoices();
      if (voices.length === 0) return;
      const gender = session?.persona?.gender;
      const enVoices = voices.filter((v) => v.lang.startsWith('en'));
      if (enVoices.length === 0) { synthVoiceRef.current = voices[0]; return; }

      // Score each voice: higher = better match for the target gender.
      // Known female voices: Samantha (macOS), Zira (Windows), Google UK English Female,
      //   Karen, Moira, Tessa, Veena, Fiona, Victoria, Susan, Joanna, Salli, Kendra, Kimberly.
      // Known male voices: Alex, Daniel, David, Google UK English Male, Tom, Fred,
      //   Matthew, Justin, Joey, Russell.
      const femaleKeywords = /samantha|zira|karen|moira|tessa|veena|fiona|victoria|susan|female|woman|joanna|salli|kendra|kimberly/i;
      const maleKeywords   = /alex|daniel|david|tom|fred|matthew|justin|joey|russell|male|man/i;

      const score = (v: SpeechSynthesisVoice) => {
        if (gender === 'female') return femaleKeywords.test(v.name) ? 2 : maleKeywords.test(v.name) ? 0 : 1;
        return maleKeywords.test(v.name) ? 2 : femaleKeywords.test(v.name) ? 0 : 1;
      };

      const best = enVoices.reduce((a, b) => (score(b) > score(a) ? b : a), enVoices[0]);
      synthVoiceRef.current = best;
    };
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
    return () => { speechSynthesis.onvoiceschanged = null; };
  }, [session?.persona?.gender]);

  // Speak text via SpeechSynthesis
  const speak = useCallback(
    (text: string) => {
      speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      if (synthVoiceRef.current) utt.voice = synthVoiceRef.current;
      utt.rate = 0.9;
      utt.pitch = session?.persona?.gender === 'female' ? 1.2 : 0.85;
      utt.onstart = () => setSessionStatus('client_speaking');
      utt.onend = () => setSessionStatus('ready');
      utt.onerror = () => setSessionStatus('ready');
      speechSynthesis.speak(utt);
    },
    [session?.persona?.gender]
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

    // Stop any ongoing speech from client
    speechSynthesis.cancel();

    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    setSessionStatus('listening');
    setInterimText('');

    recognition.onresult = (evt: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const t = evt.results[i][0].transcript;
        if (evt.results[i].isFinal) final += t;
        else interim += t;
      }
      setInterimText(interim);
      if (final) {
        sendAdvisorMessage(final.trim());
        setInterimText('');
      }
    };

    recognition.onerror = (evt: SpeechRecognitionErrorEvent) => {
      if (evt.error !== 'aborted') {
        const explain: Record<string, string> = {
          'no-speech': 'No speech detected — please speak louder or check your microphone',
          'audio-capture': 'Microphone not available — check browser permissions',
          'not-allowed': 'Microphone permission denied — allow access in your browser settings',
          'network': 'Network error in speech recognition service',
          'service-not-allowed': 'Speech recognition blocked by browser policy',
          'bad-grammar': 'Speech recognition grammar error',
          'language-not-supported': 'Speech recognition language not supported',
        };
        const detail = explain[evt.error] || evt.error;
        toast.error(`Microphone error (${evt.error}): ${detail}${evt.message ? ` — ${evt.message}` : ''}`);
      }
      setSessionStatus('ready');
      setInterimText('');
    };

    recognition.onend = () => {
      if (sessionStatus === 'listening') setSessionStatus('ready');
      setInterimText('');
    };

    recognition.start();
  }, [toast, sessionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setSessionStatus('ready');
    setInterimText('');
  }, []);

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

  const sendTextMessage = () => {
    if (!textInput.trim()) return;
    sendAdvisorMessage(textInput.trim());
    setTextInput('');
  };

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
      speechSynthesis.cancel();
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

  const toggleMic = () => {
    if (sessionStatus === 'listening') {
      stopListening();
    } else if (sessionStatus === 'ready' || sessionStatus === 'client_speaking') {
      startListening();
    }
  };

  const clientMessages = messages.filter((m) => m.role === 'client');
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
        {/* LEFT: Client Panel */}
        <div className="w-80 flex-shrink-0 bg-navy-900 border-r border-navy-700 flex flex-col">
          {/* Client profile */}
          <div className="p-5 border-b border-navy-700">
            <div className="flex flex-col items-center">
              {session?.client_image_url ? (
                <img
                  src={session.client_image_url}
                  alt={session.client_name}
                  className="w-20 h-20 rounded-full object-cover border-2 border-navy-600 mb-3"
                />
              ) : (
                <div className="w-20 h-20 rounded-full bg-navy-700 border-2 border-navy-600 flex items-center justify-center text-2xl font-bold text-gold-400 mb-3">
                  {session?.client_name?.[0] ?? '?'}
                </div>
              )}
              <div className="text-white font-semibold text-base">{session?.client_name}</div>
              {persona && (
                <div className="text-slate-500 text-xs mt-1 text-center">
                  {persona.age_group.replace('_', ' ')} · {persona.marital_status.replace('_', ' ')}
                </div>
              )}
            </div>

            {persona && (
              <div className="mt-4 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Goal</span>
                  <span className="text-slate-300">{(persona.primary_concerns ?? []).join(', ')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Risk</span>
                  <span className="text-slate-300">{persona.risk_tolerance.replace('_', ' ')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Personality</span>
                  <span className="text-slate-300">{persona.personality_type.replace('_', ' ')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Net Worth</span>
                  <span className="text-slate-300">{persona.estimated_net_worth}</span>
                </div>
              </div>
            )}
          </div>

          {/* Emotion indicator */}
          <div className="px-5 py-3 border-b border-navy-700">
            <div className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wider">Client Mood</div>
            <div className="flex items-center gap-2">
              <span className="text-xl">
                {persona?.personality_type === 'anxious'
                  ? '😰'
                  : persona?.personality_type === 'confident'
                  ? '😎'
                  : persona?.personality_type === 'skeptical'
                  ? '🤔'
                  : persona?.personality_type === 'analytical'
                  ? '📊'
                  : persona?.personality_type === 'emotional'
                  ? '💭'
                  : persona?.personality_type === 'impulsive'
                  ? '⚡'
                  : persona?.personality_type === 'detail_oriented'
                  ? '🔍'
                  : '🤝'}
              </span>
              <div>
                <div className="text-white text-sm font-medium capitalize">
                  {persona?.personality_type?.replace('_', ' ') ?? '—'}
                </div>
                <div className="text-slate-500 text-xs capitalize">
                  {persona?.communication_style} communicator
                </div>
              </div>
            </div>
          </div>

          {/* Client-side transcript */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="text-xs text-slate-500 mb-3 font-medium uppercase tracking-wider">
              Client Messages
            </div>
            <div className="space-y-3">
              {clientMessages.map((msg, i) => (
                <div
                  key={i}
                  className="bg-navy-800 rounded-lg p-3 border border-navy-700 text-sm text-slate-300 leading-relaxed"
                >
                  {msg.text}
                </div>
              ))}
              {clientMessages.length === 0 && (
                <div className="text-slate-600 text-xs italic">Waiting for session to start...</div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT: Advisor Panel */}
        <div className="flex-1 flex flex-col">
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

            <div className="flex items-center gap-4">
              {/* Mic button */}
              <button
                onClick={toggleMic}
                disabled={sessionStatus === 'processing' || sessionStatus === 'connecting' || sessionStatus === 'ended'}
                className={`w-14 h-14 rounded-full flex-shrink-0 flex items-center justify-center transition-all shadow-lg ${
                  sessionStatus === 'listening'
                    ? 'bg-red-600 hover:bg-red-700 shadow-red-500/30 scale-110 animate-pulse'
                    : sessionStatus === 'processing' || sessionStatus === 'connecting'
                    ? 'bg-navy-700 cursor-not-allowed opacity-50'
                    : 'bg-gold-500 hover:bg-gold-400 shadow-gold-500/30'
                }`}
              >
                {sessionStatus === 'listening' ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
                    <rect x="6" y="4" width="4" height="16" rx="2" />
                    <rect x="14" y="4" width="4" height="16" rx="2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-navy-900">
                    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                    <path d="M19 10v2a7 7 0 01-14 0v-2H3v2a9 9 0 008 8.94V23h2v-2.06A9 9 0 0021 12v-2h-2z" />
                  </svg>
                )}
              </button>

              {/* Text input fallback */}
              <div className="flex-1 flex gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendTextMessage(); }}
                  placeholder="Type your message (fallback for voice)..."
                  disabled={sessionStatus === 'processing' || sessionStatus === 'ended'}
                  className="flex-1 bg-navy-900 border border-navy-600 rounded-lg px-4 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-gold-500 disabled:opacity-50"
                />
                <button
                  onClick={sendTextMessage}
                  disabled={!textInput.trim() || sessionStatus === 'processing' || sessionStatus === 'ended'}
                  className="px-4 py-2.5 bg-gold-500 hover:bg-gold-400 disabled:opacity-40 disabled:cursor-not-allowed text-navy-900 font-bold rounded-lg text-sm transition-colors"
                >
                  Send
                </button>
              </div>
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
