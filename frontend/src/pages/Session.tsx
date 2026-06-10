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
 * Static client avatar — renders the persona photo with a pulsing gold ring
 * while speaking. The viseme-driven mouth overlay was removed because the
 * mouth position never lined up with the underlying stock photo's actual
 * mouth, which looked worse than a still image. For couples, pass both
 * photos via `photoUrls`; they render side-by-side in two circles, with
 * the ring highlighting only the partner whose turn it is.
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
  /** Single-photo case (individuals). */
  photoUrl?: string | null;
  /** Two-photo case (couples) — primary first, spouse second. */
  photoUrls?: (string | null | undefined)[];
  /** When `photoUrls` is set, which circle pulses (0=primary, 1=spouse). */
  activePhotoIndex?: number;
}) {
  const fallbackEmoji = PERSONALITY_EMOJI[personality ?? ''] ?? '😐';
  const urls = photoUrls && photoUrls.length > 0
    ? photoUrls
    : photoUrl ? [photoUrl] : [null];
  const isPair = urls.length >= 2;
  // For a pair, each circle is sized so the combined width matches `size`,
  // with a small gap between them.
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
            <img
              src={url}
              alt="client"
              className="w-full h-full object-cover"
              draggable={false}
            />
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
 * Streaming PCM player — plays linear16 audio chunks (24kHz mono) as they
 * arrive from the Aura-2 WebSocket TTS endpoint. Each chunk is scheduled
 * on a precise timeline using `AudioBufferSourceNode.start(when)` so there
 * are no gaps between chunks. Call `stop()` to abort immediately (used
 * for barge-in).
 *
 * Why not just <audio src> a streaming endpoint? <audio> requires a
 * containerized format (mp3/wav with full header), but Aura emits raw
 * linear16 PCM with no header — that's faster to start playing (first
 * chunk is already decodable) and avoids the mp3 frame-boundary buffering
 * stutter that <audio> introduces.
 */
/**
 * Lazily-created, SESSION-SHARED AudioContext. Chrome hard-limits a page to
 * ~6 concurrent AudioContexts — creating one per sentence (as the old code
 * did) hits that cap after a few replies and `new AudioContext()` then
 * THROWS, which got swallowed and surfaced as silent "streaming
 * unavailable". One context for the whole session sidesteps that entirely.
 */
let _sharedAudioCtx: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === 'closed') {
    // Don't force a sampleRate — Chrome may refuse or silently override.
    _sharedAudioCtx = new AudioContext();
  }
  if (_sharedAudioCtx.state === 'suspended') {
    _sharedAudioCtx.resume().catch((e) => {
      console.warn('[tts] AudioContext.resume() rejected — audio may not play:', e);
    });
  }
  return _sharedAudioCtx;
}

class StreamingPCMPlayer {
  private ctx: AudioContext;
  private sourceSampleRate: number;
  private nextStartTime: number = 0;
  private active: boolean = true;
  private scheduledNodes: AudioBufferSourceNode[] = [];
  // Carry-over for a single trailing byte when a chunk ends mid-sample.
  // Without this, an odd-length chunk drops half a sample and byte-shifts
  // every subsequent sample → continuous static/noise.
  private leftover: Uint8Array | null = null;

  constructor(sampleRate: number) {
    // Track the PCM source rate (24000) separately from the context's actual
    // rate (often 48000). createBuffer must use the SOURCE rate or the audio
    // plays at the wrong speed. Reuse the session-shared context so we never
    // hit Chrome's ~6-AudioContext-per-page ceiling.
    this.sourceSampleRate = sampleRate;
    this.ctx = getSharedAudioContext();
    console.debug(
      '[tts] player ctx state=%s ctxRate=%d sourceRate=%d',
      this.ctx.state, this.ctx.sampleRate, this.sourceSampleRate,
    );
  }

  /** Push a chunk of raw linear16 PCM bytes onto the playback timeline. */
  push(pcm: Uint8Array): void {
    if (!this.active || pcm.byteLength === 0) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* logged in getSharedAudioContext */ });
    }

    // --- Re-align samples across chunk boundaries ---------------------
    // The fetch reader hands us arbitrary byte counts. A 16-bit sample is
    // 2 bytes, so a chunk can end mid-sample. Prepend any leftover byte
    // from the previous chunk, decode only whole samples, and stash any
    // new trailing odd byte for next time. (Dropping it instead — the old
    // behavior — shifts all later samples by a byte and produces static.)
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
    if (usableBytes < bytes.byteLength) {
      this.leftover = bytes.slice(usableBytes); // 1 trailing byte
    }
    if (usableSamples === 0) return;

    // Decode via DataView with explicit little-endian — avoids any
    // ArrayBuffer alignment pitfalls from the merged/sliced views.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
    const float32 = new Float32Array(usableSamples);
    for (let i = 0; i < usableSamples; i++) {
      float32[i] = dv.getInt16(i * 2, true) / 32768;
    }

    // createBuffer's third arg is the SOURCE rate of the data (24000), not
    // the playback rate — WebAudio resamples to the context's rate on output.
    const buffer = this.ctx.createBuffer(1, float32.length, this.sourceSampleRate);
    buffer.copyToChannel(float32, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    // Schedule gaplessly after the previous chunk. The 0.05s floor only
    // applies to the very first chunk (and any underrun recovery) to give
    // the context a moment to start without clipping the leading audio.
    const startTime = Math.max(this.ctx.currentTime + 0.05, this.nextStartTime);
    source.start(startTime);
    this.scheduledNodes.push(source);
    this.nextStartTime = startTime + buffer.duration;
  }

  /** Promise that resolves when all currently-scheduled audio has finished. */
  drain(): Promise<void> {
    const remaining = this.nextStartTime - this.ctx.currentTime;
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(), Math.max(0, remaining * 1000));
      const poll = setInterval(() => {
        if (!this.active) {
          clearTimeout(t);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  }

  /** Stop this player's scheduled audio immediately (barge-in). Does NOT
   *  close the shared context — that's reused for the next sentence and
   *  torn down once on session unmount via closeSharedAudioContext(). */
  async stop(): Promise<void> {
    this.active = false;
    for (const node of this.scheduledNodes) {
      try { node.stop(); } catch { /* may have already ended */ }
      try { node.disconnect(); } catch { /* ignored */ }
    }
    this.scheduledNodes = [];
  }

  isActive(): boolean { return this.active; }
}

/** Close + free the session-shared AudioContext. Call on session unmount. */
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
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('connecting');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isVideoRecording, setIsVideoRecording] = useState(false);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  // interimText is no longer displayed (we don't show what the advisor is
  // saying — this is meant to mimic a real face-to-face appointment). The
  // state is kept so the existing setInterimText() calls in the WS / mic
  // pipeline remain no-ops, but the value is never read into a render.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_interimText, setInterimText] = useState('');
  // Mirror of activeSpeakerRef so the UI re-renders when the speaker flips
  // mid-couple-conversation (pulsing ring follows whoever is speaking).
  const [activeSpeaker, setActiveSpeaker] = useState<'primary' | 'spouse'>('primary');

  // Slide deck state. A session may have one deck (1st/2nd appt) or two
  // (3rd appt: Annuity + Private Equity) shown as tabs.
  const [decks, setDecks] = useState<Presentation[]>([]);
  const [activeDeckIndex, setActiveDeckIndex] = useState(0);
  const [slidePerDeck, setSlidePerDeck] = useState<Record<string, number>>({});
  const [slideBlobUrl, setSlideBlobUrl] = useState<string | null>(null);
  const [slideLoading, setSlideLoading] = useState(false);
  // Embed URL per deck. When set, the slide pane renders Microsoft Office
  // Online (animations preserved) instead of the static PNG.
  const [embedUrls, setEmbedUrls] = useState<Record<string, string>>({});

  const presentation = decks[activeDeckIndex] ?? null;
  const currentSlide = presentation ? (slidePerDeck[presentation.id] ?? 1) : 1;

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // (audioRef removed — the legacy <audio> blob path is gone; only the
  // StreamingPCMPlayer is used now.)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  // Couple personas only — which partner is speaking the current turn.
  // Set by the WS `active_speaker` message before the first chunk arrives;
  // the TTS queue reads this when synthesizing each sentence so the right
  // voice (primary vs spouse gender/age_group) is used.
  const activeSpeakerRef = useRef<'primary' | 'spouse'>('primary');
  // Always-current pointer to the loaded persona. We can't trust closure
  // capture in playNextSentence because the WebSocket handler may invoke
  // it via a stale callback before the React render that picks up the
  // fresh persona — the TTS call would then send gender=undefined and
  // Polly would default to Matthew for everyone. The ref is updated on
  // every render so reads inside the async path always see the latest.
  const personaRef = useRef<SessionDetail['persona'] | null>(null);
  // ---- Nova Sonic mode ----------------------------------------------------
  // When the session's voice_mode is "nova_sonic", the client's voice is
  // produced natively by Nova (no STT->Claude->ElevenLabs cascade). The
  // frontend connects to /ws/nova/{id}, plays backend-pushed 24kHz PCM, and
  // skips the local sentence-TTS path entirely.
  const novaModeRef = useRef(false);
  const novaPlayerRef = useRef<StreamingPCMPlayer | null>(null);

  // ---- Always-on interactive mic ----------------------------------------
  // The mic is hot for the entire session. VAD silence-debounce auto-sends
  // each utterance; the advisor can optionally Mute to take a phone call.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sticky "the browser blocked the mic" flag. When set, the auto-listen
  // effect stops retrying so we don't spam the user with toasts. The advisor
  // clears it via the Retry button after granting permission in the URL bar.
  const [micDenied, setMicDenied] = useState(false);
  const micDeniedRef = useRef(false);
  // Underlying error code (SpeechRecognition.error or getUserMedia DOMException
  // name) so the banner can show specifics + tailor recovery instructions.
  const [micErrorCode, setMicErrorCode] = useState<string | null>(null);
  const [micDiag, setMicDiag] = useState<{
    permission?: string;
    getUserMedia?: string;
    audioInputs?: number;
    audioInputLabels?: string[];
    audioInputIds?: string[];
  } | null>(null);
  // When the OS default mic is a phantom (asleep Bluetooth, unplugged USB,
  // etc.) Chrome reports NotFoundError. The user can pick a specific device
  // from the diagnostic dropdown; we then pin that deviceId for all future
  // getUserMedia calls in this session.
  const [preferredDeviceId, setPreferredDeviceId] = useState<string | null>(null);
  const preferredDeviceIdRef = useRef<string | null>(null);
  const [selectedDeviceChoice, setSelectedDeviceChoice] = useState<string>('');

  // ---- Avatar mouth overlay driven by Polly visemes ----------------------
  // (Viseme/lip-sync state removed — the mouth overlay never aligned with
  // stock photos. ClientAvatar is now a still image with a speaking ring.)

  // Streaming TTS player + current AbortController. ElevenLabs is the
  // only TTS path — no blob/non-streaming fallback. If the stream fails,
  // the sentence is dropped (logged) and we continue with the next.
  const streamingPlayerRef = useRef<StreamingPCMPlayer | null>(null);
  const streamingAbortRef = useRef<AbortController | null>(null);

  // ---- AWS Transcribe live streaming path --------------------------------
  // AudioContext + Worklet capture audio from the recording stream, downsample
  // to 16 kHz PCM, and post chunks to the main thread. We forward each chunk
  // as a binary WS frame to the backend, which pipes it to AWS Transcribe.
  // The backend sends back transcript_partial / transcript_final messages.
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const captureSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // True when live transcription is active. We bias toward this path; if it
  // fails to start (no SDK, bad creds), we fall back to Web Speech.
  const [transcribeLive, setTranscribeLive] = useState(false);
  const transcribeLiveRef = useRef(false);

  // Load session
  useEffect(() => {
    if (!id) return;
    sessionsApi.get(id).then((s) => {
      setSession(s);
      personaRef.current = s.persona ?? null;
      novaModeRef.current = s.voice_mode === 'nova_sonic';
      if (s.conversation?.length) {
        setMessages(s.conversation);
      }
    }).catch((err) => {
      toast.error(`Failed to load session: ${getErrorMessage(err)}`);
      setSessionStatus('error');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep the persona ref in sync whenever React state changes — defensive
  // against any path that updates `session` later (e.g., reconnect flows).
  useEffect(() => {
    personaRef.current = session?.persona ?? null;
  }, [session?.persona]);

  // Timer
  useEffect(() => {
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Helper: stop any in-flight TTS audio and free its blob URL.
  const stopAudio = useCallback(() => {
    // Abort the in-flight fetch + stop scheduled audio.
    if (streamingAbortRef.current) {
      try { streamingAbortRef.current.abort(); } catch { /* ignored */ }
      streamingAbortRef.current = null;
    }
    if (streamingPlayerRef.current) {
      void streamingPlayerRef.current.stop();
      streamingPlayerRef.current = null;
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
      // Tear down the AudioWorklet pipeline (inline so we don't depend on
      // stopLiveTranscribe being declared yet).
      transcribeLiveRef.current = false;
      if (workletNodeRef.current) {
        try { workletNodeRef.current.disconnect(); } catch { /* ignore */ }
        workletNodeRef.current = null;
      }
      if (captureSourceRef.current) {
        try { captureSourceRef.current.disconnect(); } catch { /* ignore */ }
        captureSourceRef.current = null;
      }
      if (audioContextRef.current) {
        try { void audioContextRef.current.close(); } catch { /* ignore */ }
        audioContextRef.current = null;
      }
      stopAudio();
      // Tear down the session-shared TTS playback context.
      void closeSharedAudioContext();
    };
  }, [stopAudio]);

  // Fetch the deck(s) for THIS session based on its appointment type.
  // Third appointments return two decks (Annuity + Private Equity).
  // After decks load, also fetch the Office Online embed URL for each so
  // we can render the animated viewer when available.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    sessionsApi.presentations(id)
      .then((list) => {
        if (cancelled) return;
        setDecks(list);
        setActiveDeckIndex(0);
        setSlidePerDeck(Object.fromEntries(list.map((d) => [d.id, 1])));
        // Fetch embed URLs in parallel. Each is independent — one failing
        // doesn't block the others, and a null result triggers PNG fallback.
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

  // Speak a single message via streaming TTS (ElevenLabs). Used for the
  // one-shot replay path (e.g., re-speaking the opening greeting when a
  // session is reloaded mid-conversation). Same player class as the
  // sentence queue uses — sub-300ms time-to-first-audio.
  const speak = useCallback(
    async (text: string) => {
      stopAudio();
      try {
        setSessionStatus('client_speaking');
        const p = personaRef.current;
        const gender = p?.gender as ('male' | 'female' | undefined);
        const ageGroup = p?.age_group as (
          'young_adult' | 'middle_aged' | 'senior' | 'elderly' | undefined
        );
        const abort = new AbortController();
        streamingAbortRef.current = abort;
        const player = new StreamingPCMPlayer(24000);
        streamingPlayerRef.current = player;
        let chunkCount = 0;
        const meta = await ttsApi.streamPCM(
          text, gender, ageGroup,
          (chunk) => {
            if (abort.signal.aborted) return;
            chunkCount += 1;
            player.push(chunk);
          },
          abort.signal,
        );
        if (meta && chunkCount > 0) {
          await player.drain();
        } else if (!abort.signal.aborted) {
          console.warn('[tts] speak(): no audio — meta=%o chunks=%d', meta, chunkCount);
        }
        if (streamingPlayerRef.current === player) {
          await player.stop();
          streamingPlayerRef.current = null;
        }
        if (streamingAbortRef.current === abort) streamingAbortRef.current = null;
        setSessionStatus('ready');
      } catch (err) {
        stopAudio();
        toast.error(`TTS error: ${getErrorMessage(err)}`);
        setSessionStatus('ready');
      }
    },
    [stopAudio, toast]
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
    // Always read from the ref — closure may have been captured before the
    // session GET resolved, in which case session?.persona would be
    // undefined and TTS would silently default to a male voice.
    const p = personaRef.current;
    // For couple personas the active speaker may flip per turn — pick the
    // matching voice. Outside a couple, this just lands on the primary.
    const isCoupleTurn =
      p?.client_type === 'couple' &&
      activeSpeakerRef.current === 'spouse' &&
      !!p?.spouse_gender;
    const gender = (isCoupleTurn ? p?.spouse_gender : p?.gender) as (
      'male' | 'female' | undefined
    );
    const ageGroup = (
      isCoupleTurn
        ? (p?.spouse_age_group ??
            // Fallback: bucket spouse_age into the four groups so legacy
            // couple profiles without an explicit spouse_age_group still
            // get a sensible voice.
            (() => {
              const a = p?.spouse_age;
              if (a == null) return 'middle_aged';
              if (a < 35) return 'young_adult';
              if (a < 55) return 'middle_aged';
              if (a < 70) return 'senior';
              return 'elderly';
            })())
        : p?.age_group
    ) as ('young_adult' | 'middle_aged' | 'senior' | 'elderly' | undefined);
    // One-time diagnostic so any voice-confusion report has a paper trail
    // in the browser console.
    console.debug('[tts] sentence chars=%d gender=%s age=%s couple=%s',
      next.length, gender, ageGroup, isCoupleTurn);
    try {
      setSessionStatus('client_speaking');
      // Streaming PCM from ElevenLabs Flash v2.5. First audio chunk
      // arrives in ~250ms; no blob/non-streaming fallback (would mean
      // 2+ second silence anyway and Polly's gone). On stream failure
      // we just log + skip this sentence.
      const abort = new AbortController();
      streamingAbortRef.current = abort;
      try {
        // Construct the player UP FRONT (not lazily inside onChunk) so any
        // AudioContext failure surfaces here with its real message instead
        // of being swallowed by streamPCM's read-loop catch.
        const player = new StreamingPCMPlayer(24000);
        streamingPlayerRef.current = player;
        let chunkCount = 0;
        const meta = await ttsApi.streamPCM(
          next, gender, ageGroup,
          (chunk) => {
            if (abort.signal.aborted) return;
            chunkCount += 1;
            player.push(chunk);
          },
          abort.signal,
        );
        if (meta && chunkCount > 0) {
          await player.drain();
          if (streamingPlayerRef.current === player) {
            await player.stop();
            streamingPlayerRef.current = null;
          }
        } else if (!abort.signal.aborted) {
          console.warn(
            '[tts] no audio — meta=%o chunks=%d (200+bytes expected). Sentence skipped.',
            meta, chunkCount,
          );
          await player.stop();
          if (streamingPlayerRef.current === player) streamingPlayerRef.current = null;
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          console.warn('[tts] streaming failed — sentence skipped:', err);
        }
      } finally {
        if (streamingAbortRef.current === abort) streamingAbortRef.current = null;
      }
    } catch (err) {
      console.warn('TTS sentence failed:', err);
    } finally {
      ttsPlayingRef.current = false;
      // Continue draining; if interrupted, the queue was cleared so this exits.
      if (ttsQueueRef.current.length > 0) {
        void playNextSentence();
      } else if (!streamingRef.current) {
        setSessionStatus('ready');
      }
    }
  }, [session?.persona?.gender, session?.persona?.age_group]);

  const enqueueSentences = useCallback((sentences: string[]) => {
    // In Nova Sonic mode the client's voice is streamed as audio from the
    // backend — never synthesize locally via ElevenLabs.
    if (novaModeRef.current) return;
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

  // MediaRecorder setup — camera and microphone are acquired as INDEPENDENT
  // getUserMedia calls so a failure in one doesn't kill the other. The
  // session can run with any subset of available devices:
  //
  //   • both → video + audio recording, normal flow
  //   • video only → silent video recording (camera works, mic is missing)
  //   • audio only → audio recording (no webcam)
  //   • neither → no recording, but the session UI + client TTS still work
  //
  // Audio failures still flip the micDenied flag so the recovery banner +
  // device picker show up; SpeechRecognition will likely fail too.
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
      // Kick off the live AWS Transcribe pipeline. We do this as soon as we
      // have an audio track so the worklet starts producing PCM frames even
      // before MediaRecorder is wired up. Frames are buffered/dropped while
      // the WS isn't open yet — no harm.
      if (audioTrack) {
        // Fire-and-forget; errors fall back to Web Speech inside the helper.
        void startLiveTranscribe(audioTrack);
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const friendly = explain[e.name || ''] || e.message || 'unknown error';
      console.warn('Audio unavailable:', err);
      toast.warning(`Microphone unavailable — ${friendly}. Session will continue without it.`);
      // Flip the denied flag so the banner + device picker appear, and the
      // auto-listen loop doesn't spin retrying SpeechRecognition.
      if (
        e.name === 'NotAllowedError' ||
        e.name === 'SecurityError' ||
        e.name === 'NotFoundError' ||
        e.name === 'NotReadableError' ||
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
      // Only toast on permission-style failures, not "no camera installed".
      if (e.name === 'NotAllowedError' || e.name === 'NotReadableError' || e.name === 'SecurityError') {
        toast.warning(`Camera unavailable — ${friendly}. Session will continue without it.`);
      }
    }

    if (!audioTrack && !videoTrack) {
      toast.error(
        'No microphone or camera available. The session UI and client audio still work, ' +
        'but the session won\'t be recorded. Plug in a device and click Retry mic.',
      );
      return;
    }

    // Build a single MediaStream from whichever tracks we got.
    const combined = new MediaStream();
    if (audioTrack) combined.addTrack(audioTrack);
    if (videoTrack) combined.addTrack(videoTrack);
    mediaStreamRef.current = combined;
    setIsVideoRecording(!!videoTrack);
    setHasAudioTrack(!!audioTrack);

    // Pick a mimeType matching what we actually have. Without video tracks
    // we want audio/webm so the browser doesn't try to encode an empty video.
    const mimeType = videoTrack
      ? (MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'audio/webm')
      : 'audio/webm';

    try {
      const mr = new MediaRecorder(combined, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.start(10000); // collect chunks every 10s
      setIsRecording(true);
    } catch (err) {
      const e = err as Error;
      console.error('MediaRecorder failed:', e);
      toast.error(`Recording setup failed: ${e.message}`);
    }
  }, [toast]);

  // WebSocket setup — defer creation to next tick so StrictMode's double-invoke
  // can cancel the first attempt before the socket actually opens.
  useEffect(() => {
    // Wait for the session to load so we know which voice engine to use
    // (the WS endpoint differs for Nova Sonic).
    if (!id || !token || !session) return;
    const novaMode = session.voice_mode === 'nova_sonic';
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECTS = 3;

    const connect = () => {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const path = novaMode ? `/ws/nova/${id}` : `/ws/session/${id}`;
      const wsUrl = `${wsProtocol}//${window.location.host}${path}?token=${token}`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        if (reconnectAttempts > 0) {
          // We just recovered from a drop — let the advisor know.
          toast.success('Reconnected.');
        }
        reconnectAttempts = 0;
        setSessionStatus('ready');
        startRecording();
      };

      ws.onmessage = (evt) => {
        // Nova Sonic mode: the client's voice arrives as raw 24kHz PCM binary
        // frames. Play them through a persistent StreamingPCMPlayer.
        if (novaMode && evt.data instanceof ArrayBuffer) {
          if (!novaPlayerRef.current) novaPlayerRef.current = new StreamingPCMPlayer(24000);
          novaPlayerRef.current.push(new Uint8Array(evt.data));
          setSessionStatus('client_speaking');
          return;
        }
        try {
          const data = JSON.parse(evt.data as string) as {
            type: string;
            text?: string;
            message?: string;
            timestamp?: string;
            speaker?: 'primary' | 'spouse';
          };
          // Server keepalive — backend sends this every ~25s to defeat
          // intermediate proxy idle timeouts. Nothing to do; the very
          // act of receiving it counts as the browser confirming the
          // socket is alive.
          if (data.type === 'ping') return;
          if (data.type === 'transcript_partial' && data.text) {
            // Live interim transcript from AWS Transcribe. Show as the
            // advisor's in-progress speech (same slot as Web Speech interim).
            setInterimText(data.text);
          } else if (data.type === 'transcript_final' && data.text) {
            // Final utterance committed by Transcribe. Backend has already
            // kicked off Claude; we just need to add the advisor's bubble.
            const text = data.text.trim();
            setInterimText('');
            if (text) {
              const advMsg: ConversationMessage = {
                role: 'advisor',
                text,
                timestamp: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, advMsg]);
            }
          } else if (data.type === 'auto_interrupt') {
            // Server-side barge-in: advisor started talking during client TTS.
            // Mirror the manual Interrupt button's local cleanup.
            ttsQueueRef.current = [];
            unspokenBufRef.current = '';
            stopAudio();
            // Nova mode: stop the streamed client audio immediately.
            if (novaPlayerRef.current) {
              void novaPlayerRef.current.stop();
              novaPlayerRef.current = null;
            }
            streamingRef.current = false;
            streamMsgIndexRef.current = null;
            setSessionStatus('listening');
          } else if (data.type === 'client_response_cancelled') {
            // Claude stream was cancelled mid-flight (barge-in). Clean up
            // the in-progress bubble.
            streamingRef.current = false;
            streamMsgIndexRef.current = null;
          } else if (data.type === 'transcribe_unavailable') {
            // Backend couldn't start Transcribe; we'll fall back to Web
            // Speech. Toast once so the advisor knows latency may be worse.
            transcribeLiveRef.current = false;
            setTranscribeLive(false);
            toast.warning(`Real-time transcription unavailable, falling back to slower path: ${data.message || ''}`);
          } else if (data.type === 'client_response_start') {
            // Reset to the primary speaker until the backend tells us
            // otherwise. For couples, an `active_speaker` message arrives
            // before the first chunk.
            activeSpeakerRef.current = 'primary';
            setActiveSpeaker('primary');
            handleClientStart(data.timestamp || '');
          } else if (data.type === 'active_speaker') {
            // Couple personas: which partner is speaking this turn.
            const who = data.speaker === 'spouse' ? 'spouse' : 'primary';
            activeSpeakerRef.current = who;
            setActiveSpeaker(who);
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
          'WebSocket connection failed. Check that the backend is running on port 8081 ' +
          'and that your auth token is still valid. See browser console for details.'
        );
      };

      ws.onclose = (ev) => {
        if (cancelled || endingRef.current) return;
        // Unexpected close — try to reconnect a few times before giving
        // up. This recovers from idle-timeout drops at intermediate
        // proxies, transient network blips, and AWS Transcribe hiccups.
        // The session row stays in `active` if the backend's WS handler
        // sees the close as a clean WebSocketDisconnect (the keepalive
        // ping reduces these), so reconnecting picks up where we left off.
        if (reconnectAttempts < MAX_RECONNECTS) {
          reconnectAttempts += 1;
          const delay = Math.min(2000 * reconnectAttempts, 5000);
          console.warn(
            `[ws] closed (code=${ev.code} reason=${ev.reason || '-'}); ` +
            `reconnect attempt ${reconnectAttempts}/${MAX_RECONNECTS} in ${delay}ms`,
          );
          toast.warning(`Connection dropped — reconnecting…`);
          setSessionStatus('connecting');
          setTimeout(() => {
            if (!cancelled && !endingRef.current) connect();
          }, delay);
          return;
        }
        console.error(`[ws] gave up reconnecting after ${MAX_RECONNECTS} attempts`);
        setSessionStatus('error');
        toast.error('Lost connection to the session. Please refresh.');
      };
    };

    const timer = setTimeout(() => {
      if (cancelled) return;
      connect();
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ws?.close();
      if (novaPlayerRef.current) {
        void novaPlayerRef.current.stop();
        novaPlayerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token, session?.voice_mode]);

  // Speak first client message on load if conversation already has messages.
  // Skipped in one-sided practice mode (engage_client=false) — the client
  // never speaks there.
  useEffect(() => {
    if (session?.engage_client && session?.voice_mode !== 'nova_sonic'
        && messages.length === 1 && messages[0].role === 'client') {
      setTimeout(() => speak(messages[0].text), 800);
    }
  }, [messages, speak, session?.engage_client]);

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
        // Permission-related errors flip the sticky micDenied flag so the
        // auto-listen effect stops re-firing in a loop. Toast only once;
        // the in-page banner provides ongoing instructions + Retry.
        const isPermission =
          evt.error === 'not-allowed' ||
          evt.error === 'audio-capture' ||
          evt.error === 'service-not-allowed';
        if (isPermission) {
          if (!micDeniedRef.current) {
            toast.error(`Microphone blocked: ${detail}`);
          }
          micDeniedRef.current = true;
          setMicDenied(true);
          setMicErrorCode(`SpeechRecognition/${evt.error}`);
        } else {
          toast.error(`Microphone error (${evt.error}): ${detail}${evt.message ? ` — ${evt.message}` : ''}`);
        }
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

  // Advisor clicked "Retry mic" after granting permission in browser settings.
  // We clear the sticky denied flag and let the auto-listen effect fire.
  const retryMic = useCallback(async () => {
    micDeniedRef.current = false;
    setMicDenied(false);
    setMicErrorCode(null);
    setMicDiag(null);
    // If recording never started (initial getUserMedia denial), retry that too.
    if (!isRecording) {
      try {
        await startRecording();
      } catch {
        /* startRecording handles its own toasting */
      }
    }
    // Effect will fire startListening once status === 'ready' and recording
    // is up. Nudge sessionStatus in case we were stuck.
    setSessionStatus('ready');
  }, [isRecording, startRecording]);

  // Start the AudioWorklet pipeline that streams 16 kHz PCM frames to the
  // backend over the WebSocket. Backend pipes them into AWS Transcribe and
  // returns transcript_partial / transcript_final messages. Far more
  // responsive than Web Speech (sub-second partials, server-side barge-in).
  const startLiveTranscribe = useCallback(async (audioTrack: MediaStreamTrack) => {
    try {
      const ctx = new AudioContext();
      // Worklet module served by Vite from /public.
      await ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
      const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      const node = new AudioWorkletNode(ctx, 'pcm-capture-worklet');

      // Worklet posts Int16Array chunks (~100 ms each). Forward them as
      // binary WS frames. We deliberately don't connect `node` to the audio
      // destination — that would loop the advisor's voice back into the
      // speakers and confuse them (and the recognizer).
      node.port.onmessage = (e) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          // e.data is an Int16Array; sending it sends its underlying buffer.
          ws.send(e.data as unknown as ArrayBufferView);
        } catch {
          /* socket likely closed mid-frame */
        }
      };

      source.connect(node);
      audioContextRef.current = ctx;
      workletNodeRef.current = node;
      captureSourceRef.current = source;
      transcribeLiveRef.current = true;
      setTranscribeLive(true);
    } catch (err) {
      console.warn('Live transcribe setup failed; falling back to Web Speech:', err);
      transcribeLiveRef.current = false;
      setTranscribeLive(false);
    }
  }, []);

  const stopLiveTranscribe = useCallback(() => {
    transcribeLiveRef.current = false;
    setTranscribeLive(false);
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { /* ignore */ }
      workletNodeRef.current = null;
    }
    if (captureSourceRef.current) {
      try { captureSourceRef.current.disconnect(); } catch { /* ignore */ }
      captureSourceRef.current = null;
    }
    if (audioContextRef.current) {
      try { void audioContextRef.current.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
    }
  }, []);

  // Pin a specific audio input device (chosen from the diagnostic dropdown)
  // and restart the recording pipeline against it. Useful when the OS default
  // is broken (asleep Bluetooth, etc.) but other inputs are available.
  const useDevice = useCallback(async (deviceId: string, label?: string) => {
    if (!deviceId) {
      toast.error('Pick a device from the dropdown first');
      return;
    }
    try {
      // Verify the device actually works before we pin it. Open + close.
      const probe = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      const err = e as { name?: string; message?: string };
      toast.error(`That device didn't work: ${err.name ?? 'Error'} — ${err.message ?? ''}`);
      return;
    }

    preferredDeviceIdRef.current = deviceId;
    setPreferredDeviceId(deviceId);

    // Tear down any existing recording stream so startRecording rebuilds it
    // with the new constraints.
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      /* already stopped */
    }
    setIsRecording(false);

    // Clear the denied state and re-run the full pipeline.
    micDeniedRef.current = false;
    setMicDenied(false);
    setMicErrorCode(null);
    await startRecording();
    setSessionStatus('ready');
    toast.success(`Using ${label || 'selected microphone'}`);
  }, [startRecording, toast]);

  // Probe the actual browser permission state + an isolated getUserMedia call
  // + enumerateDevices. The combination disambiguates between three very
  // different problems: site permission, OS-level permission, and "no audio
  // input device exists at all" (NotFoundError).
  const runMicDiagnostic = useCallback(async () => {
    const result: {
      permission?: string;
      getUserMedia?: string;
      audioInputs?: number;
      audioInputLabels?: string[];
      audioInputIds?: string[];
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
      result.audioInputLabels = inputs.map(
        (d) => d.label || '(label hidden — grant mic first)',
      );
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

  // Auto-open the Web Speech recognizer whenever we're ready and not muted.
  // This is the FALLBACK path — when the live AWS Transcribe pipeline is
  // running (transcribeLive=true), the AudioWorklet is already streaming
  // PCM to the backend, so we skip Web Speech entirely.
  //
  // Important guards:
  //   • !transcribeLive — don't fight the live pipeline.
  //   • !micDenied — stop retrying if the browser blocked the mic, otherwise
  //     setSessionStatus('ready') in the error handler would loop forever.
  //   • isRecording — ensure getUserMedia has actually granted the mic before
  //     we ask SpeechRecognition for it (avoids racing the permission prompt).
  useEffect(() => {
    if (transcribeLiveRef.current) return;
    if (mutedRef.current) return;
    if (micDeniedRef.current) return;
    if (!isRecording) return;
    if (sessionStatus !== 'ready') return;
    if (recognitionRef.current && isTalkingRef.current) return;
    const t = setTimeout(() => {
      if (
        !transcribeLiveRef.current &&
        !mutedRef.current &&
        !micDeniedRef.current &&
        sessionStatus === 'ready'
      ) {
        startListening();
      }
    }, 150);
    return () => clearTimeout(t);
  }, [sessionStatus, startListening, isRecording, micDenied, transcribeLive]);

  // Silence the client without opening the mic — pure "shush" control.
  // Clears the entire sentence-level TTS queue so no further audio plays
  // even if more chunks are still streaming in from the server.
  const interruptClient = useCallback(() => {
    ttsQueueRef.current = [];
    unspokenBufRef.current = '';
    stopAudio();
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
      stopLiveTranscribe();
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

  // Abandon the session WITHOUT saving or analyzing it. Tears the live
  // session down like End, but skips the recording upload and the
  // end/analyze call — then asks the backend to delete the session (and
  // revert any backing assignment so it can be started again).
  const handleDiscardSession = async () => {
    setIsDiscarding(true);
    endingRef.current = true; // stop the WS reconnect loop
    setShowDiscardConfirm(false);

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setIsRecording(false);
    setIsVideoRecording(false);

    try {
      stopAudio();
      stopLiveTranscribe();
      isTalkingRef.current = false;
      recognitionRef.current?.stop();
      // Stop the recorder but DO NOT upload — we're throwing this away.
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* already stopped */ }
      }
      chunksRef.current = [];
      // Close the socket without sending end_session (no completion/analysis).
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
      }
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
          {/* Live-voice engine badge — confirms at a glance whether this
              session is running on Nova Sonic (native S2S) or the cascade. */}
          <span
            className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${
              session?.voice_mode === 'nova_sonic'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-navy-700 text-slate-400 border border-navy-600'
            }`}
            title="Live-voice engine for this session"
          >
            {session?.voice_mode === 'nova_sonic' ? 'Nova Sonic' : 'Standard'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Recording indicator — shows exactly what's being captured. */}
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
                  {embedUrls[presentation.id]
                    ? <span className="text-gold-400">Animated · {presentation.slide_count} slides</span>
                    : <>Slide {currentSlide} / {presentation.slide_count}</>}
                </div>
              </div>

              {/* Slide body — Office Online iframe when embed URL is available
                  (animations preserved); otherwise the static PNG renderer. */}
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
                  {/* PNG-only slide nav. The iframe has its own controls. */}
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

        {/* RIGHT: Advisor Panel (40%) */}
        <div className="w-[40%] min-w-[420px] flex flex-col">
          {/* Hero client photo / avatar — replaces the transcript so the
              advisor focuses on the person, not the text. The avatar
              animates (lip-sync via mouthOpenness) while the client speaks. */}
          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-navy-900 to-navy-800 overflow-hidden">
            {!session ? (
              <div className="text-center">
                <div className="text-4xl mb-3">🎙️</div>
                <div className="text-slate-500">Connecting to session...</div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-6 w-full">
                {/* Hero avatar — still photo with a speaking-state ring. For
                    couples we render BOTH photos side-by-side and pulse the
                    ring around whichever partner is currently speaking. */}
                <div className="relative">
                  <ClientAvatar
                    size={320}
                    isSpeaking={sessionStatus === 'client_speaking'}
                    personality={persona?.personality_type}
                    photoUrl={session?.client_image_url ?? null}
                    photoUrls={
                      persona?.client_type === 'couple'
                        ? [
                            session?.client_image_url ?? null,
                            persona?.spouse_image_url ?? null,
                          ]
                        : undefined
                    }
                    activePhotoIndex={activeSpeaker === 'spouse' ? 1 : 0}
                  />
                  {/* Status pill anchored to the avatar */}
                  <div className="absolute -bottom-2 left-1/2 -translate-x-1/2">
                    <div
                      className={`px-3 py-1 rounded-full text-xs font-medium shadow-lg ${
                        sessionStatus === 'client_speaking'
                          ? 'bg-gold-500 text-navy-900'
                          : sessionStatus === 'processing'
                          ? 'bg-blue-500 text-white'
                          : sessionStatus === 'listening'
                          ? 'bg-green-500 text-white'
                          : 'bg-navy-700 text-slate-300'
                      }`}
                    >
                      {session && session.engage_client === false
                        ? (sessionStatus === 'listening' ? 'Recording' : 'Ready')
                        : sessionStatus === 'client_speaking'
                        ? 'Speaking…'
                        : sessionStatus === 'processing'
                        ? 'Thinking…'
                        : sessionStatus === 'listening'
                        ? 'Listening'
                        : 'Ready'}
                    </div>
                  </div>
                </div>

                {/* Name + persona descriptor below the photo */}
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
                  {/* Practice-mode banner — the client won't respond. */}
                  {session && session.engage_client === false && (
                    <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-navy-700 border border-navy-600 text-slate-300 text-xs">
                      <span>🎯</span>
                      <span>Practice walkthrough — present the deck; the client won't respond. You're still being recorded &amp; scored.</span>
                    </div>
                  )}
                </div>

                {/* Intentionally no on-screen text. This is meant to feel
                    like a real client appointment — the advisor talks, the
                    client listens, both watch each other's face. The full
                    transcript is still captured server-side for the
                    post-session scorecard but is never shown live. */}
              </div>
            )}
          </div>

          {/* Voice interface */}
          <div className="border-t border-navy-700 bg-navy-800 p-5">
            {/* Mic-permission recovery banner. Shows persistently when the
                browser has blocked mic access. Includes a diagnostic probe so
                the advisor can tell whether the block is at the browser level,
                the OS level, or a stale page state. */}
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
                            <p>
                              Chrome can't see any audio input device on this machine. This is a
                              hardware / OS-state issue, not a permission issue.
                            </p>
                            <ol className="list-decimal list-inside space-y-0.5 ml-1">
                              <li>
                                Make sure a microphone is connected — built-in, USB headset, Bluetooth
                                headset (and that the Bluetooth device isn't asleep).
                              </li>
                              <li>
                                <span className="font-medium text-red-100">macOS:</span>{' '}
                                <em>System Settings → Sound → Input</em> — at least one input device
                                must be listed and selected. Also{' '}
                                <em>System Settings → Privacy &amp; Security → Microphone</em> — Chrome
                                must be enabled (when OS hides the device entirely, Chrome reports
                                NotFoundError, not Denied).
                              </li>
                              <li>
                                <span className="font-medium text-red-100">Windows:</span>{' '}
                                <em>Settings → System → Sound → Input</em> — a device must be active
                                and not muted.
                              </li>
                              <li>
                                Click <span className="font-medium text-red-100">Run diagnostic</span>{' '}
                                below to see exactly which audio devices Chrome can see, then plug in
                                / enable one and click Retry.
                              </li>
                            </ol>
                          </>
                        ) : isInUse ? (
                          <>
                            <p>
                              Another application has an exclusive lock on the microphone.
                              Common culprits: Zoom, Teams, FaceTime, Discord, OBS.
                            </p>
                            <ol className="list-decimal list-inside space-y-0.5 ml-1">
                              <li>Quit (don't just minimize) any other app that uses the mic.</li>
                              <li>Then click Retry.</li>
                            </ol>
                          </>
                        ) : (
                          <>
                            <p>
                              If Chrome's <span className="font-medium text-red-100">Site settings</span>{' '}
                              already say Allow, the most likely fixes are (in order):
                            </p>
                            <ol className="list-decimal list-inside space-y-0.5 ml-1">
                              <li>
                                <span className="font-medium text-red-100">Hard-refresh this page</span>{' '}
                                (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows). Chrome caches the old
                                permission state until reload.
                              </li>
                              <li>
                                <span className="font-medium text-red-100">
                                  Check OS-level mic permission for Chrome.
                                </span>{' '}
                                macOS: <em>System Settings → Privacy &amp; Security → Microphone</em>{' '}
                                — Chrome must be enabled. Windows:{' '}
                                <em>Settings → Privacy → Microphone → Allow desktop apps</em>.
                              </li>
                              <li>
                                Make sure no other app (Zoom, Teams, FaceTime) has an exclusive lock on
                                the mic.
                              </li>
                              <li>As a last resort, try a different browser or an incognito window.</li>
                            </ol>
                          </>
                        )}
                      </div>
                      {micDiag && (
                        <div className="mt-3 bg-navy-900/60 border border-red-700/30 rounded px-2 py-1.5 text-[11px] font-mono leading-snug text-red-100/90">
                          <div>permissions.query → {micDiag.permission ?? '—'}</div>
                          <div>getUserMedia(audio) → {micDiag.getUserMedia ?? '—'}</div>
                          <div>
                            audio inputs visible to Chrome: {micDiag.audioInputs ?? '—'}
                          </div>
                          {micDiag.audioInputLabels && micDiag.audioInputLabels.length > 0 && (
                            <div className="mt-1 pl-3">
                              {micDiag.audioInputLabels.map((label, i) => (
                                <div key={i}>• {label}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {/* Device picker — appears only when Chrome can see at
                          least one audio input. Lets the advisor pick a
                          specific device (bypasses a broken OS default). */}
                      {micDiag && micDiag.audioInputIds && micDiag.audioInputIds.length > 0 && (
                        <div className="mt-3 bg-navy-900/60 border border-gold-500/30 rounded p-2.5">
                          <div className="text-xs text-gold-300 font-semibold mb-1.5">
                            Try a specific microphone
                          </div>
                          <div className="flex gap-2 items-stretch">
                            <select
                              value={selectedDeviceChoice}
                              onChange={(e) => setSelectedDeviceChoice(e.target.value)}
                              className="flex-1 bg-navy-900 border border-navy-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-gold-500 min-w-0"
                            >
                              <option value="">— pick an input device —</option>
                              {micDiag.audioInputIds.map((id, i) => (
                                <option key={id || i} value={id}>
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
