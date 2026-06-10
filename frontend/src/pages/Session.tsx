import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sessionsApi, presentationsApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/Toast';
import ConfirmModal from '../components/ConfirmModal';
import { getErrorMessage } from '../utils/errors';
import type { SessionDetail, Presentation } from '../types';

type SessionStatus = 'connecting' | 'ready' | 'client_speaking' | 'ended' | 'error';

const STATUS_LABEL: Record<SessionStatus, string> = {
  connecting: 'Connecting...',
  ready: 'Ready — recording',
  client_speaking: 'Client is speaking...',
  ended: 'Session ended',
  error: 'Connection error',
};

const STATUS_COLOR: Record<SessionStatus, string> = {
  connecting: 'text-blue-400',
  ready: 'text-green-400',
  client_speaking: 'text-gold-400',
  ended: 'text-slate-500',
  error: 'text-red-500',
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const PERSONALITY_EMOJI: Record<string, string> = {
  anxious: '😰', confident: '😎', skeptical: '🤔', analytical: '🧐',
  emotional: '😢', impulsive: '😤', detail_oriented: '🤓', trusting: '😊',
};

/**
 * Static client avatar — renders the persona photo with a pulsing gold ring
 * while speaking. For couples, pass both photos via `photoUrls`; they render
 * side-by-side, with the ring on the partner whose turn it is.
 */
function ClientAvatar({
  size,
  isSpeaking,
  personality,
  photoUrl,
  photoUrls,
  activePhotoIndex,
}: {
  size: number;
  isSpeaking: boolean;
  personality?: string;
  photoUrl?: string | null;
  photoUrls?: (string | null | undefined)[];
  activePhotoIndex?: number;
}) {
  const fallbackEmoji = PERSONALITY_EMOJI[personality ?? ''] ?? '😐';
  const urls = photoUrls && photoUrls.length > 0
    ? photoUrls
    : photoUrl ? [photoUrl] : [null];
  const isPair = urls.length >= 2;
  const circleSize = isPair ? Math.round(size * 0.58) : size;

  const renderCircle = (url: string | null | undefined, idx: number) => {
    const showRing = isSpeaking && (!isPair || (activePhotoIndex ?? 0) === idx);
    return (
      <div
        key={idx}
        className="relative flex-shrink-0 select-none"
        style={{ width: circleSize, height: circleSize }}
      >
        {showRing && (
          <span className="absolute -inset-1 rounded-full ring-2 ring-gold-400/70 animate-pulse pointer-events-none" />
        )}
        <div className="absolute inset-0 rounded-full overflow-hidden bg-navy-700 border border-navy-600 flex items-center justify-center">
          {url ? (
            <img src={url} alt="client" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <span className="leading-none" style={{ fontSize: circleSize * 0.7 }}>{fallbackEmoji}</span>
          )}
        </div>
      </div>
    );
  };

  if (!isPair) return renderCircle(urls[0], 0);
  return (
    <div className="flex items-center gap-4" style={{ height: size }}>
      {urls.slice(0, 2).map((u, i) => renderCircle(u, i))}
    </div>
  );
}

/**
 * Lazily-created, SESSION-SHARED AudioContext. Chrome hard-limits a page to
 * ~6 concurrent AudioContexts, so we reuse one for the whole session. Used
 * by the Nova Sonic 24kHz playback path.
 */
let _sharedAudioCtx: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === 'closed') {
    _sharedAudioCtx = new AudioContext();
  }
  if (_sharedAudioCtx.state === 'suspended') {
    _sharedAudioCtx.resume().catch(() => { /* logged below */ });
  }
  return _sharedAudioCtx;
}

/**
 * Streaming PCM player — plays linear16 audio chunks (24kHz mono) gaplessly as
 * they arrive from the Nova Sonic WebSocket. Call `stop()` for barge-in.
 */
class StreamingPCMPlayer {
  private ctx: AudioContext;
  private sourceSampleRate: number;
  private nextStartTime = 0;
  private active = true;
  private scheduledNodes: AudioBufferSourceNode[] = [];
  // Carry-over for a trailing byte when a chunk ends mid-sample (else static).
  private leftover: Uint8Array | null = null;

  constructor(sampleRate: number) {
    this.sourceSampleRate = sampleRate;
    this.ctx = getSharedAudioContext();
  }

  push(pcm: Uint8Array): void {
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
    const usableSamples = bytes.byteLength >>> 1;
    const usableBytes = usableSamples * 2;
    if (usableBytes < bytes.byteLength) this.leftover = bytes.slice(usableBytes);
    if (usableSamples === 0) return;

    const dv = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
    const float32 = new Float32Array(usableSamples);
    for (let i = 0; i < usableSamples; i++) float32[i] = dv.getInt16(i * 2, true) / 32768;

    const buffer = this.ctx.createBuffer(1, float32.length, this.sourceSampleRate);
    buffer.copyToChannel(float32, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startTime = Math.max(this.ctx.currentTime + 0.05, this.nextStartTime);
    source.start(startTime);
    this.scheduledNodes.push(source);
    this.nextStartTime = startTime + buffer.duration;
  }

  async stop(): Promise<void> {
    this.active = false;
    for (const node of this.scheduledNodes) {
      try { node.stop(); } catch { /* ended */ }
      try { node.disconnect(); } catch { /* ignored */ }
    }
    this.scheduledNodes = [];
    this.leftover = null;
  }
}

async function closeSharedAudioContext(): Promise<void> {
  if (_sharedAudioCtx && _sharedAudioCtx.state !== 'closed') {
    try { await _sharedAudioCtx.close(); } catch { /* already closed */ }
  }
  _sharedAudioCtx = null;
}

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('connecting');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isVideoRecording, setIsVideoRecording] = useState(false);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  // Slide deck state. A session may have one deck (1st/2nd appt) or two
  // (3rd appt: Annuity + Private Equity) shown as tabs.
  const [decks, setDecks] = useState<Presentation[]>([]);
  const [activeDeckIndex, setActiveDeckIndex] = useState(0);
  const [slidePerDeck, setSlidePerDeck] = useState<Record<string, number>>({});
  const [slideBlobUrl, setSlideBlobUrl] = useState<string | null>(null);
  const [slideLoading, setSlideLoading] = useState(false);
  const [embedUrls, setEmbedUrls] = useState<Record<string, string>>({});

  const presentation = decks[activeDeckIndex] ?? null;
  const currentSlide = presentation ? (slidePerDeck[presentation.id] ?? 1) : 1;

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endingRef = useRef(false);
  const recordingStartedRef = useRef(false);

  // Nova Sonic mode: the client's voice is produced natively by Nova over
  // /ws/nova; we play the backend-pushed 24kHz PCM here. One-way mode uses
  // NO websocket — it only records + tracks slides locally.
  const novaPlayerRef = useRef<StreamingPCMPlayer | null>(null);

  // Slide-change timeline, collected client-side and sent at session end
  // (works the same whether or not there's a WebSocket).
  const slideEventsRef = useRef<Array<{ slide_number: number; presentation_id: string; timestamp: string }>>([]);

  // ---- Mic permission recovery (recording) --------------------------------
  const [micDenied, setMicDenied] = useState(false);
  const micDeniedRef = useRef(false);
  const [micErrorCode, setMicErrorCode] = useState<string | null>(null);
  const [micDiag, setMicDiag] = useState<{
    permission?: string;
    getUserMedia?: string;
    audioInputs?: number;
    audioInputLabels?: string[];
    audioInputIds?: string[];
  } | null>(null);
  const [preferredDeviceId, setPreferredDeviceId] = useState<string | null>(null);
  const preferredDeviceIdRef = useRef<string | null>(null);
  const [selectedDeviceChoice, setSelectedDeviceChoice] = useState<string>('');

  // Load session
  useEffect(() => {
    if (!id) return;
    sessionsApi.get(id).then((s) => {
      setSession(s);
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

  // Stop any in-flight Nova playback (barge-in / teardown).
  const stopNovaPlayback = useCallback(() => {
    if (novaPlayerRef.current) {
      void novaPlayerRef.current.stop();
      novaPlayerRef.current = null;
    }
  }, []);

  // Cleanup on unmount — stop camera/mic + audio even if the user navigates away.
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
      stopNovaPlayback();
      void closeSharedAudioContext();
    };
  }, [stopNovaPlayback]);

  // Fetch the deck(s) for THIS session + Office Online embed URLs.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    sessionsApi.presentations(id)
      .then((list) => {
        if (cancelled) return;
        setDecks(list);
        setActiveDeckIndex(0);
        setSlidePerDeck(Object.fromEntries(list.map((d) => [d.id, 1])));
        list.forEach((d) => {
          presentationsApi.getEmbedUrl(d.id)
            .then((r) => {
              if (cancelled || !r.embed_url) return;
              setEmbedUrls((prev) => ({ ...prev, [d.id]: r.embed_url as string }));
            })
            .catch(() => { /* fall back to PNG silently */ });
        });
      })
      .catch(() => setDecks([]));
    return () => { cancelled = true; };
  }, [id]);

  // Fetch the current slide's PNG whenever it changes.
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

  useEffect(() => {
    return () => {
      if (slideBlobUrl && slideBlobUrl.startsWith('blob:')) URL.revokeObjectURL(slideBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigate to a slide. Slide changes are tracked client-side and sent to the
  // backend at session end (no WebSocket dependency).
  const goToSlide = useCallback((n: number) => {
    if (!presentation) return;
    const clamped = Math.max(1, Math.min(presentation.slide_count, n));
    if (clamped === currentSlide) return;
    setSlidePerDeck((prev) => ({ ...prev, [presentation.id]: clamped }));
    slideEventsRef.current.push({
      slide_number: clamped,
      presentation_id: presentation.id,
      timestamp: new Date().toISOString(),
    });
  }, [presentation, currentSlide]);

  // MediaRecorder setup — camera and microphone are acquired as INDEPENDENT
  // getUserMedia calls so a failure in one doesn't kill the other. Recording
  // runs in BOTH modes and is independent of any WebSocket.
  const startRecording = useCallback(async () => {
    const pinnedId = preferredDeviceIdRef.current;
    const audioConstraint = pinnedId
      ? ({ deviceId: { exact: pinnedId } } as MediaTrackConstraints)
      : (true as boolean);

    const explain: Record<string, string> = {
      NotAllowedError: 'permission denied',
      NotFoundError: 'no device found',
      NotReadableError: 'device in use by another app',
      OverconstrainedError: 'no device matches constraints',
      SecurityError: 'blocked by browser security policy',
    };

    let audioTrack: MediaStreamTrack | null = null;
    let videoTrack: MediaStreamTrack | null = null;

    // --- AUDIO -----------------------------------------------------------
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      audioTrack = audioStream.getAudioTracks()[0] ?? null;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const friendly = explain[e.name || ''] || e.message || 'unknown error';
      console.warn('Audio unavailable:', err);
      toast.warning(`Microphone unavailable — ${friendly}. Session will continue without it.`);
      if (
        e.name === 'NotAllowedError' || e.name === 'SecurityError' ||
        e.name === 'NotFoundError' || e.name === 'NotReadableError' ||
        e.name === 'OverconstrainedError'
      ) {
        micDeniedRef.current = true;
        setMicDenied(true);
        setMicErrorCode(`getUserMedia/${e.name}`);
      }
    }

    // --- VIDEO (independent) --------------------------------------------
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoTrack = videoStream.getVideoTracks()[0] ?? null;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const friendly = explain[e.name || ''] || e.message || 'unknown error';
      console.warn('Camera unavailable:', err);
      if (e.name === 'NotAllowedError' || e.name === 'NotReadableError' || e.name === 'SecurityError') {
        toast.warning(`Camera unavailable — ${friendly}. Session will continue without it.`);
      }
    }

    if (!audioTrack && !videoTrack) {
      toast.error(
        'No microphone or camera available. The session still runs, but it won\'t be ' +
        'recorded. Plug in a device and click Retry mic.',
      );
      return;
    }

    const combined = new MediaStream();
    if (audioTrack) combined.addTrack(audioTrack);
    if (videoTrack) combined.addTrack(videoTrack);
    mediaStreamRef.current = combined;
    setIsVideoRecording(!!videoTrack);
    setHasAudioTrack(!!audioTrack);

    if (videoTrack && !audioTrack) {
      toast.error('Microphone not available — recording will have video but NO audio. Check browser mic permissions and click Retry mic.');
    }

    // Prefer explicit vp8+opus so the browser always encodes audio when both
    // tracks are present. Fall back to plain video/webm then audio/webm.
    let mimeType = 'audio/webm';
    if (videoTrack) {
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
        mimeType = 'video/webm;codecs=vp8,opus';
      } else if (MediaRecorder.isTypeSupported('video/webm')) {
        mimeType = 'video/webm';
      }
    }

    try {
      const mr = new MediaRecorder(combined, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(10000); // collect chunks every 10s
      setIsRecording(true);
    } catch (err) {
      const e = err as Error;
      console.error('MediaRecorder failed:', e);
      toast.error(`Recording setup failed: ${e.message}`);
    }
  }, [toast]);

  // Start recording once the session has loaded — independent of any
  // WebSocket, so a dropped/absent socket never interrupts the recording.
  useEffect(() => {
    if (!session || recordingStartedRef.current) return;
    recordingStartedRef.current = true;
    setSessionStatus('ready');
    void startRecording();
  }, [session, startRecording]);

  // ---- Nova Sonic WebSocket (ONLY in nova_sonic mode) --------------------
  // The advisor's mic streams to Nova as 16kHz PCM; Nova streams the client's
  // 24kHz voice + transcript back. One-way mode opens no socket at all.
  useEffect(() => {
    if (!id || !token || !session) return;
    if (session.voice_mode !== 'nova_sonic') return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let captureCtx: AudioContext | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECTS = 3;

    // Wire the mic worklet → 16kHz PCM → WS binary frames (for Nova input).
    const startMicCapture = async () => {
      try {
        const track = mediaStreamRef.current?.getAudioTracks()[0];
        if (!track) return;
        const ctx = new AudioContext();
        captureCtx = ctx;
        await ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
        // Resume in case the AudioContext started suspended (Chrome autoplay policy).
        if (ctx.state === 'suspended') await ctx.resume();
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const node = new AudioWorkletNode(ctx, 'pcm-capture-worklet');
        node.port.onmessage = (e) => {
          const sock = wsRef.current;
          if (!sock || sock.readyState !== WebSocket.OPEN) return;
          try { sock.send(e.data as unknown as ArrayBufferView); } catch { /* closed */ }
        };
        source.connect(node);
        // Connect through a muted gain to ctx.destination so the Web Audio
        // pull model keeps the processing graph active. Without this the
        // worklet's process() is never invoked on some browsers.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(ctx.destination);
      } catch (err) {
        console.warn('Nova mic capture setup failed:', err);
      }
    };

    const connect = () => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/nova/${id}?token=${token}`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        if (reconnectAttempts > 0) toast.success('Reconnected.');
        reconnectAttempts = 0;
        setSessionStatus('ready');
        void startMicCapture();
      };

      ws.onmessage = (evt) => {
        // Client voice: raw 24kHz PCM binary frames → play them.
        if (evt.data instanceof ArrayBuffer) {
          if (!novaPlayerRef.current) novaPlayerRef.current = new StreamingPCMPlayer(24000);
          novaPlayerRef.current.push(new Uint8Array(evt.data));
          setSessionStatus('client_speaking');
          return;
        }
        try {
          const data = JSON.parse(evt.data as string) as { type: string; message?: string };
          if (data.type === 'ping') return;
          if (data.type === 'client_response_start') {
            setSessionStatus('client_speaking');
          } else if (data.type === 'client_response_end' || data.type === 'turn_complete') {
            setSessionStatus('ready');
          } else if (data.type === 'auto_interrupt') {
            // Barge-in: the advisor talked over the client — stop playback.
            stopNovaPlayback();
            setSessionStatus('ready');
          } else if (data.type === 'error') {
            toast.error(data.message || 'Session error');
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        // Don't hard-fail — onclose handles reconnect. Recording is unaffected.
        console.warn('[ws] nova socket error');
      };

      ws.onclose = (ev) => {
        if (cancelled || endingRef.current) return;
        if (reconnectAttempts < MAX_RECONNECTS) {
          reconnectAttempts += 1;
          const delay = Math.min(2000 * reconnectAttempts, 5000);
          console.warn(`[ws] nova closed (code=${ev.code}); reconnect ${reconnectAttempts}/${MAX_RECONNECTS} in ${delay}ms`);
          toast.warning('Voice connection dropped — reconnecting…');
          setTimeout(() => { if (!cancelled && !endingRef.current) connect(); }, delay);
          return;
        }
        // Recording keeps going regardless; just note the voice link is down.
        toast.warning('Voice connection lost. Your recording continues; refresh to restore the client voice.');
      };
    };

    const timer = setTimeout(() => { if (!cancelled) connect(); }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ws?.close();
      if (captureCtx) { try { void captureCtx.close(); } catch { /* ignore */ } }
      stopNovaPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token, session?.voice_mode]);

  // ---- Mic recovery helpers (recording) ----------------------------------
  const useDevice = useCallback(async (deviceId: string, label?: string) => {
    if (!deviceId) { toast.error('Pick a device from the dropdown first'); return; }
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      const err = e as { name?: string; message?: string };
      toast.error(`That device didn't work: ${err.name ?? 'Error'} — ${err.message ?? ''}`);
      return;
    }
    preferredDeviceIdRef.current = deviceId;
    setPreferredDeviceId(deviceId);
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
    setIsRecording(false);
    micDeniedRef.current = false;
    setMicDenied(false);
    setMicErrorCode(null);
    await startRecording();
    setSessionStatus('ready');
    toast.success(`Using ${label || 'selected microphone'}`);
  }, [startRecording, toast]);

  const runMicDiagnostic = useCallback(async () => {
    const result: {
      permission?: string; getUserMedia?: string;
      audioInputs?: number; audioInputLabels?: string[]; audioInputIds?: string[];
    } = {};
    try {
      const perm = await (navigator as { permissions?: { query: (q: { name: string }) => Promise<PermissionStatus> } })
        .permissions?.query({ name: 'microphone' });
      result.permission = perm ? perm.state : '(API unavailable)';
    } catch (e) {
      result.permission = `query failed: ${(e as Error).message}`;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      result.audioInputs = inputs.length;
      result.audioInputLabels = inputs.map((d) => d.label || '(label hidden — grant mic first)');
      result.audioInputIds = inputs.map((d) => d.deviceId);
    } catch (e) {
      result.audioInputLabels = [`enumerate failed: ${(e as Error).message}`];
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      result.getUserMedia = 'OK';
    } catch (e) {
      const err = e as { name?: string; message?: string };
      result.getUserMedia = `${err.name ?? 'Error'}: ${err.message ?? '(no message)'}`;
    }
    setMicDiag(result);
  }, []);

  const retryMic = useCallback(async () => {
    micDeniedRef.current = false;
    setMicDenied(false);
    setMicErrorCode(null);
    setMicDiag(null);
    if (!isRecording) {
      try { await startRecording(); } catch { /* startRecording toasts itself */ }
    }
    setSessionStatus('ready');
  }, [isRecording, startRecording]);

  const handleEndSession = async () => {
    setIsEnding(true);
    endingRef.current = true;
    setShowEndConfirm(false);

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    const wasVideoRecording = isVideoRecording;
    setIsRecording(false);
    setIsVideoRecording(false);

    try {
      stopNovaPlayback();

      // Stop recording & upload.
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

      // Close the Nova socket (if any).
      if (wsRef.current) {
        try { wsRef.current.send(JSON.stringify({ type: 'end_session' })); } catch { /* ignore */ }
        try { wsRef.current.close(); } catch { /* ignore */ }
      }

      // End session → persist slide events + trigger post-session analysis.
      if (id) {
        await sessionsApi.end(id, slideEventsRef.current);
        toast.success('Session ended. Analysis will be available shortly on your dashboard.');
        navigate('/dashboard');
      }
    } catch (err) {
      console.error('End session error:', err);
      toast.error(`Failed to end session: ${getErrorMessage(err)}`);
      setIsEnding(false);
    }
  };

  // Abandon the session WITHOUT saving or analyzing it.
  const handleDiscardSession = async () => {
    setIsDiscarding(true);
    endingRef.current = true;
    setShowDiscardConfirm(false);

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setIsRecording(false);
    setIsVideoRecording(false);

    try {
      stopNovaPlayback();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* already stopped */ }
      }
      chunksRef.current = [];
      if (wsRef.current) { try { wsRef.current.close(); } catch { /* ignore */ } }
      if (id) {
        await sessionsApi.discard(id);
        toast.success('Session discarded — nothing was saved. You can start it again.');
        navigate('/dashboard');
      }
    } catch (err) {
      console.error('Discard session error:', err);
      toast.error(`Failed to discard session: ${getErrorMessage(err)}`);
      setIsDiscarding(false);
    }
  };

  const persona = session?.persona;
  const isNova = session?.voice_mode === 'nova_sonic';

  return (
    <div className="flex flex-col h-screen bg-navy-900">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-6 py-3 bg-navy-800 border-b border-navy-700 flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="text-gold-400 font-bold text-sm flex items-center gap-2">
            {(() => {
              if (!session?.persona) return session?.client_name ?? 'Loading...';
              const p = session.persona;
              if (p.client_type === 'couple' && p.spouse_name) {
                return (
                  <>
                    <span>{p.name} & {p.spouse_name}</span>
                    <span className="text-[10px] uppercase tracking-wider bg-navy-700 text-slate-300 px-1.5 py-0.5 rounded">
                      Couple
                    </span>
                  </>
                );
              }
              return session.client_name ?? p.name;
            })()}
          </div>
          <div className="flex items-center gap-1.5 bg-navy-900 px-3 py-1 rounded-full">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-slate-500">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
            </svg>
            <span className="text-slate-400 text-xs font-mono">{formatTime(elapsedSeconds)}</span>
          </div>
          {/* Mode badge */}
          <span
            className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${
              isNova
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-navy-700 text-slate-400 border border-navy-600'
            }`}
            title="Session mode"
          >
            {isNova ? 'Nova Sonic' : 'Practice (record-only)'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {isRecording && (
            <div className="flex items-center gap-1.5 bg-red-900/40 border border-red-800 px-3 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 text-xs font-semibold">
                {isVideoRecording && hasAudioTrack
                  ? 'REC · video+audio'
                  : isVideoRecording
                  ? 'REC · video only'
                  : 'REC · audio'}
              </span>
            </div>
          )}

          <button
            onClick={() => setShowDiscardConfirm(true)}
            disabled={isEnding || isDiscarding}
            title="Stop without saving or scoring — you can start this session again"
            className="border border-navy-600 hover:border-slate-400 text-slate-300 hover:text-white disabled:opacity-50 font-semibold px-3 py-1.5 rounded-lg text-sm transition-colors"
          >
            {isDiscarding ? 'Discarding...' : 'Discard'}
          </button>
          <button
            onClick={() => setShowEndConfirm(true)}
            disabled={isEnding || isDiscarding}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-semibold px-4 py-1.5 rounded-lg text-sm transition-colors"
          >
            {isEnding ? 'Ending...' : 'End Session'}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: Slide Pane */}
        <div className="flex-1 bg-navy-950 border-r border-navy-700 flex flex-col min-w-0">
          {presentation ? (
            <>
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

              <div className="px-5 py-3 border-b border-navy-700 flex items-center justify-between bg-navy-900">
                <div className="flex items-center gap-3">
                  {decks.length > 1 && presentation.slot_label && (
                    <span className="text-gold-400 text-xs font-semibold uppercase tracking-wider">{presentation.slot_label}</span>
                  )}
                  <span className="text-slate-300 text-sm font-semibold truncate max-w-md">{presentation.title}</span>
                  <span className="text-slate-500 text-xs">v{presentation.version}</span>
                </div>
                <div className="text-slate-400 text-sm font-mono">
                  {embedUrls[presentation.id]
                    ? <span className="text-gold-400">Animated · {presentation.slide_count} slides</span>
                    : <>Slide {currentSlide} / {presentation.slide_count}</>}
                </div>
              </div>

              {embedUrls[presentation.id] ? (
                <div className="flex-1 bg-navy-950 overflow-hidden">
                  <iframe
                    key={presentation.id}
                    src={embedUrls[presentation.id]}
                    title={presentation.title}
                    className="w-full h-full border-0"
                    allow="fullscreen"
                  />
                </div>
              ) : (
                <>
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
              )}
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

        {/* RIGHT: Advisor Panel */}
        <div className="w-[40%] min-w-[420px] flex flex-col">
          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-navy-900 to-navy-800 overflow-hidden">
            {!session ? (
              <div className="text-center">
                <div className="text-4xl mb-3">🎙️</div>
                <div className="text-slate-500">Connecting to session...</div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-6 w-full">
                <div className="relative">
                  <ClientAvatar
                    size={320}
                    isSpeaking={sessionStatus === 'client_speaking'}
                    personality={persona?.personality_type}
                    photoUrl={session?.client_image_url ?? null}
                    photoUrls={
                      persona?.client_type === 'couple'
                        ? [session?.client_image_url ?? null, persona?.spouse_image_url ?? null]
                        : undefined
                    }
                    activePhotoIndex={0}
                  />
                  <div className="absolute -bottom-2 left-1/2 -translate-x-1/2">
                    <div
                      className={`px-3 py-1 rounded-full text-xs font-medium shadow-lg ${
                        sessionStatus === 'client_speaking'
                          ? 'bg-gold-500 text-navy-900'
                          : isRecording
                          ? 'bg-green-500 text-white'
                          : 'bg-navy-700 text-slate-300'
                      }`}
                    >
                      {sessionStatus === 'client_speaking'
                        ? 'Speaking…'
                        : isRecording
                        ? 'Recording'
                        : 'Ready'}
                    </div>
                  </div>
                </div>

                <div className="text-center">
                  <div className="text-white text-xl font-semibold">
                    {persona?.client_type === 'couple' && persona?.spouse_name
                      ? `${persona.name} & ${persona.spouse_name}`
                      : session?.client_name ?? persona?.name}
                  </div>
                  {persona && (
                    <div className="text-slate-500 text-xs mt-1">
                      {persona.age_group.replace('_', ' ')}
                      {' · '}
                      {persona.personality_type.replace('_', ' ')}
                    </div>
                  )}
                  {isNova ? (
                    <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-900/30 border border-emerald-700/50 text-emerald-200 text-xs">
                      <span>🗣️</span>
                      <span>Live conversation — just talk to {persona?.name ?? 'the client'}. They'll respond out loud.</span>
                    </div>
                  ) : (
                    <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-navy-700 border border-navy-600 text-slate-300 text-xs">
                      <span>🎯</span>
                      <span>Practice walkthrough — present the deck; the client won't respond. You're being recorded &amp; scored.</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Status + mic-permission recovery */}
          <div className="border-t border-navy-700 bg-navy-800 p-5">
            {micDenied && (() => {
              const isNotFound = micErrorCode?.includes('NotFoundError');
              const isInUse = micErrorCode?.includes('NotReadableError');
              return (
                <div className="mb-4 rounded-lg border border-red-700/60 bg-red-900/30 p-3 text-sm">
                  <div className="flex items-start gap-3">
                    <span className="text-xl leading-none mt-0.5">🎤</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-red-200 font-semibold mb-1">
                        {isNotFound
                          ? 'No microphone detected'
                          : isInUse
                          ? 'Microphone is in use by another app'
                          : 'Microphone access is blocked'}
                      </div>
                      {micErrorCode && (
                        <div className="text-red-100/60 text-[11px] font-mono mb-2">code: {micErrorCode}</div>
                      )}
                      <div className="text-red-100/85 text-xs leading-relaxed space-y-1.5">
                        {isNotFound ? (
                          <>
                            <p>Chrome can't see any audio input device. This is a hardware / OS-state issue, not a permission issue.</p>
                            <ol className="list-decimal list-inside space-y-0.5 ml-1">
                              <li>Make sure a microphone is connected (built-in, USB, or Bluetooth — and not asleep).</li>
                              <li><span className="font-medium text-red-100">macOS:</span> <em>System Settings → Sound → Input</em>, and <em>Privacy &amp; Security → Microphone</em> (Chrome enabled).</li>
                              <li><span className="font-medium text-red-100">Windows:</span> <em>Settings → System → Sound → Input</em> — a device must be active.</li>
                              <li>Click <span className="font-medium text-red-100">Run diagnostic</span>, then enable a device and click Retry.</li>
                            </ol>
                          </>
                        ) : isInUse ? (
                          <>
                            <p>Another app (Zoom, Teams, FaceTime, Discord, OBS) has an exclusive lock on the microphone.</p>
                            <ol className="list-decimal list-inside space-y-0.5 ml-1">
                              <li>Quit (don't just minimize) the other app.</li>
                              <li>Then click Retry.</li>
                            </ol>
                          </>
                        ) : (
                          <>
                            <p>If Chrome's <span className="font-medium text-red-100">Site settings</span> already say Allow, try these in order:</p>
                            <ol className="list-decimal list-inside space-y-0.5 ml-1">
                              <li><span className="font-medium text-red-100">Hard-refresh</span> (Cmd+Shift+R / Ctrl+Shift+R).</li>
                              <li>Check OS-level mic permission for Chrome.</li>
                              <li>Make sure no other app holds the mic.</li>
                              <li>As a last resort, try a different browser / incognito window.</li>
                            </ol>
                          </>
                        )}
                      </div>
                      {micDiag && (
                        <div className="mt-3 bg-navy-900/60 border border-red-700/30 rounded px-2 py-1.5 text-[11px] font-mono leading-snug text-red-100/90">
                          <div>permissions.query → {micDiag.permission ?? '—'}</div>
                          <div>getUserMedia(audio) → {micDiag.getUserMedia ?? '—'}</div>
                          <div>audio inputs visible to Chrome: {micDiag.audioInputs ?? '—'}</div>
                          {micDiag.audioInputLabels && micDiag.audioInputLabels.length > 0 && (
                            <div className="mt-1 pl-3">
                              {micDiag.audioInputLabels.map((label, i) => (<div key={i}>• {label}</div>))}
                            </div>
                          )}
                        </div>
                      )}
                      {micDiag && micDiag.audioInputIds && micDiag.audioInputIds.length > 0 && (
                        <div className="mt-3 bg-navy-900/60 border border-gold-500/30 rounded p-2.5">
                          <div className="text-xs text-gold-300 font-semibold mb-1.5">Try a specific microphone</div>
                          <div className="flex gap-2 items-stretch">
                            <select
                              value={selectedDeviceChoice}
                              onChange={(e) => setSelectedDeviceChoice(e.target.value)}
                              className="flex-1 bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-gold-500 min-w-0"
                            >
                              <option value="">— pick an input device —</option>
                              {micDiag.audioInputIds.map((devId, i) => (
                                <option key={devId || i} value={devId}>
                                  {micDiag.audioInputLabels?.[i] ?? `Device ${i + 1}`}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => {
                                if (!selectedDeviceChoice) return;
                                const idx = micDiag.audioInputIds!.indexOf(selectedDeviceChoice);
                                const label = idx >= 0 ? micDiag.audioInputLabels?.[idx] : undefined;
                                void useDevice(selectedDeviceChoice, label);
                              }}
                              disabled={!selectedDeviceChoice}
                              className="bg-gold-500 hover:bg-gold-400 disabled:opacity-40 disabled:cursor-not-allowed text-navy-900 font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
                            >
                              Use this device
                            </button>
                          </div>
                          {preferredDeviceId && (
                            <div className="text-[10px] text-gold-300/70 mt-1.5">
                              Pinned to deviceId {preferredDeviceId.slice(0, 12)}…
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      <button
                        onClick={retryMic}
                        className="bg-red-700 hover:bg-red-600 text-white font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
                      >
                        Retry mic
                      </button>
                      <button
                        onClick={runMicDiagnostic}
                        className="bg-navy-700 hover:bg-navy-600 text-slate-200 font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap border border-navy-600"
                      >
                        Run diagnostic
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            <div className="flex items-center justify-center">
              <span className={`text-sm font-medium ${STATUS_COLOR[sessionStatus]}`}>
                {STATUS_LABEL[sessionStatus]}
              </span>
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

      {/* Discard (no save / no analysis) Confirmation */}
      <ConfirmModal
        isOpen={showDiscardConfirm}
        title="Discard this session?"
        message="This stops the session without saving the recording or running any analysis. Nothing is scored or kept. If this was an assigned session, it returns to your dashboard so you can start it again."
        confirmLabel="Discard & Exit"
        cancelLabel="Keep Going"
        confirmClassName="bg-red-600 hover:bg-red-700 text-white"
        onConfirm={handleDiscardSession}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </div>
  );
}
