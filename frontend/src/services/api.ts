import axios from 'axios';
import type {
  User,
  AdvisorWithStats,
  SessionPublic,
  SessionDetail,
  SessionAnalysis,
  ClientPersona,
  QuestionnaireContent,
  Presentation,
  TrainingScript,
  SessionProfile,
  Assignment,
  MyAssignments,
  AssignmentStatus,
} from '../types';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: attach Bearer token, and DROP the default JSON
// Content-Type when the payload is FormData. Axios v1.x respects the
// instance-level default Content-Type even for multipart payloads, which
// would otherwise cause FastAPI to reject the upload as malformed JSON
// (HTTP 422). Deleting it here lets the browser/axios set the correct
// `multipart/form-data; boundary=…` automatically.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    // Remove any preset Content-Type so axios/browser picks the multipart one.
    if (config.headers && 'Content-Type' in config.headers) {
      delete (config.headers as Record<string, unknown>)['Content-Type'];
    }
    if (config.headers && 'content-type' in config.headers) {
      delete (config.headers as Record<string, unknown>)['content-type'];
    }
  }
  return config;
});

// Response interceptor: redirect to /login on 401, but NOT during login itself
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const isLoginRequest = error.config?.url?.includes('/auth/login');
    if (error.response?.status === 401 && !isLoginRequest) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth
export const authApi = {
  login: async (email: string, password: string): Promise<{ access_token: string; token_type: string; user: User }> => {
    const response = await api.post('/auth/login', { email, password });
    return response.data;
  },
  me: async (): Promise<User> => {
    const response = await api.get('/auth/me');
    return response.data;
  },
};

// Advisors (admin only)
export const advisorsApi = {
  list: async (): Promise<AdvisorWithStats[]> => {
    const response = await api.get('/advisors');
    return response.data;
  },
  create: async (data: { name: string; email: string; password: string; role: string }): Promise<User> => {
    const response = await api.post('/advisors', data);
    return response.data;
  },
  update: async (id: string, data: Partial<User> & { password?: string }): Promise<User> => {
    const response = await api.put(`/advisors/${id}`, data);
    return response.data;
  },
  resetPassword: async (id: string, password: string): Promise<User> => {
    const response = await api.put(`/advisors/${id}`, { password });
    return response.data;
  },
  deactivate: async (id: string): Promise<void> => {
    await api.delete(`/advisors/${id}`);
  },
};

// Sessions
export const sessionsApi = {
  list: async (params?: { source?: 'assigned' | 'self_initiated'; advisor_id?: string }): Promise<SessionPublic[]> => {
    const response = await api.get('/sessions', { params });
    return response.data;
  },
  create: async (
    persona: Partial<ClientPersona>,
    engageClient = false,
    voiceMode: 'standard' | 'nova_sonic' = 'standard',
  ): Promise<SessionDetail> => {
    const response = await api.post('/sessions', {
      persona,
      engage_client: engageClient,
      voice_mode: voiceMode,
    });
    return response.data;
  },
  /** Start a session that the admin assigned. Persona is locked server-side.
   *  `engageClient` (default false) — when false the client stays silent and
   *  it's a one-sided deck-walkthrough practice. `voiceMode` picks the live
   *  voice engine ('standard' cascade or 'nova_sonic' native S2S). */
  createFromAssignment: async (
    assignmentId: string,
    engageClient = false,
    voiceMode: 'standard' | 'nova_sonic' = 'standard',
  ): Promise<SessionDetail> => {
    const response = await api.post('/sessions', {
      assignment_id: assignmentId,
      engage_client: engageClient,
      voice_mode: voiceMode,
    });
    return response.data;
  },
  get: async (id: string): Promise<SessionDetail> => {
    const response = await api.get(`/sessions/${id}`);
    return response.data;
  },
  /** Decks the advisor should present for this session (appointment-type aware). */
  presentations: async (id: string): Promise<import('../types').Presentation[]> => {
    const response = await api.get(`/sessions/${id}/presentations`);
    return response.data;
  },
  /** End the session and trigger analysis. `slideEvents` (one-way mode, which
   *  has no WebSocket) carries the slide-change timeline collected client-side. */
  end: async (
    id: string,
    slideEvents?: Array<{ slide_number: number; presentation_id?: string; timestamp: string }>,
  ): Promise<void> => {
    await api.post(`/sessions/${id}/end`, slideEvents?.length ? { slide_events: slideEvents } : {});
  },
  /** Abandon an active session without saving or analyzing it. Deletes the
   *  session and reverts any backing assignment to startable. */
  discard: async (id: string): Promise<void> => {
    await api.post(`/sessions/${id}/discard`);
  },
  uploadRecording: async (id: string, blob: Blob): Promise<void> => {
    const formData = new FormData();
    formData.append('recording', blob, blob.type.includes('video') ? 'recording.webm' : 'recording.webm');
    // Browser auto-sets multipart/form-data with the correct boundary.
    await api.post(`/sessions/${id}/recording`, formData);
  },
  getRecordingUrl: (id: string): string => {
    const token = localStorage.getItem('auth_token') || '';
    return `/api/sessions/${id}/recording?token=${encodeURIComponent(token)}`;
  },
  getAnalysis: async (id: string): Promise<SessionAnalysis> => {
    const response = await api.get(`/sessions/${id}/analysis`);
    return response.data;
  },
};

// Questionnaire
// The backend returns QuestionnairePublic: { id, version, content: {...}, created_at, is_active }.
// We unwrap `content` so the editor sees { version, updated_at, categories, ... } directly.
function unwrapQuestionnaire(pub: { version: number; created_at: string; content: Record<string, unknown> }): QuestionnaireContent {
  return {
    ...(pub.content as Partial<QuestionnaireContent>),
    version: pub.version,
    updated_at: pub.created_at,
  } as QuestionnaireContent;
}

export const questionnaireApi = {
  get: async (): Promise<QuestionnaireContent> => {
    const response = await api.get('/questionnaire');
    return unwrapQuestionnaire(response.data);
  },
  update: async (data: QuestionnaireContent): Promise<QuestionnaireContent> => {
    const response = await api.put('/questionnaire', data);
    return unwrapQuestionnaire(response.data);
  },
};

// Presentations (admin-uploaded slide decks)
export const presentationsApi = {
  list: async (slot?: string): Promise<Presentation[]> => {
    const response = await api.get('/presentations', { params: slot ? { slot } : undefined });
    return response.data;
  },
  getActive: async (slot?: string): Promise<Presentation | null> => {
    try {
      const response = await api.get('/presentations/active', { params: slot ? { slot } : undefined });
      return response.data;
    } catch (err: unknown) {
      // 404 means no active deck — return null instead of throwing
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  },
  upload: async (
    title: string,
    files: File | File[],
    script?: File | null,
    slot: string = 'first',
  ): Promise<Presentation> => {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('slot', slot);
    // Backend accepts list[UploadFile]; append each File under the `files` key.
    const list = Array.isArray(files) ? files : [files];
    for (const f of list) formData.append('files', f);
    if (script) formData.append('script', script);
    // Content-Type is handled by the axios request interceptor, which strips
    // the default JSON header for FormData so the browser sets the multipart
    // boundary automatically.
    const response = await api.post('/presentations', formData);
    return response.data;
  },
  attachScript: async (id: string, script: File): Promise<Presentation> => {
    const formData = new FormData();
    formData.append('script', script);
    const response = await api.post(`/presentations/${id}/script`, formData);
    return response.data;
  },
  removeScript: async (id: string): Promise<Presentation> => {
    const response = await api.delete(`/presentations/${id}/script`);
    return response.data;
  },
  /** Fetch the attached script PDF as a blob (uses axios header auth). */
  fetchScriptBlob: async (id: string): Promise<Blob> => {
    const response = await api.get(`/presentations/${id}/script`, { responseType: 'blob' });
    return response.data;
  },
  activate: async (id: string): Promise<Presentation> => {
    const response = await api.post(`/presentations/${id}/activate`);
    return response.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/presentations/${id}`);
  },
  slideUrl: (id: string, slideNumber: number): string => {
    // Returns a URL the <img> tag can hit directly. The axios interceptor adds
    // the bearer token via header, but <img src> can't carry headers — so we
    // append the token as a query param if present.
    const token = localStorage.getItem('auth_token') || '';
    return `/api/presentations/${id}/slides/${slideNumber}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },
  // For programmatic fetch where we want to use axios + interceptor auth
  fetchSlideBlob: async (id: string, slideNumber: number): Promise<Blob> => {
    const response = await api.get(`/presentations/${id}/slides/${slideNumber}`, {
      responseType: 'blob',
    });
    return response.data;
  },
  /**
   * Microsoft Office Online viewer URL for the deck. Returns null when the
   * embed isn't available (no S3 bucket / no local PPTX); caller falls back
   * to the static PNG renderer.
   */
  getEmbedUrl: async (id: string): Promise<{ embed_url: string | null; expires_in: number | null }> => {
    const response = await api.get(`/presentations/${id}/embed-url`);
    return response.data;
  },
};

// Training scripts (markdown)
export const scriptsApi = {
  list: async (): Promise<TrainingScript[]> => {
    const response = await api.get('/scripts');
    return response.data;
  },
  getActive: async (): Promise<TrainingScript | null> => {
    try {
      const response = await api.get('/scripts/active');
      return response.data;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  },
  create: async (data: { title: string; content: string }): Promise<TrainingScript> => {
    const response = await api.post('/scripts', data);
    return response.data;
  },
  activate: async (id: string): Promise<TrainingScript> => {
    const response = await api.post(`/scripts/${id}/activate`);
    return response.data;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/scripts/${id}`);
  },
};

// Session profiles (admin)
export const profilesApi = {
  list: async (includeInactive = false): Promise<SessionProfile[]> => {
    const response = await api.get('/profiles', {
      params: { include_inactive: includeInactive },
    });
    return response.data;
  },
  get: async (id: string): Promise<SessionProfile> => {
    const response = await api.get(`/profiles/${id}`);
    return response.data;
  },
  create: async (data: { name: string; description?: string; persona: Partial<ClientPersona> }): Promise<SessionProfile> => {
    const response = await api.post('/profiles', data);
    return response.data;
  },
  update: async (id: string, data: Partial<{ name: string; description: string; persona: Partial<ClientPersona>; is_active: boolean }>): Promise<SessionProfile> => {
    const response = await api.patch(`/profiles/${id}`, data);
    return response.data;
  },
  remove: async (id: string): Promise<void> => {
    await api.delete(`/profiles/${id}`);
  },
};

// Assignments (admin creates, advisor lists own)
export const assignmentsApi = {
  /** Admin: list all assignments, optionally filtered. */
  list: async (params?: { advisor_id?: string; status_filter?: AssignmentStatus }): Promise<Assignment[]> => {
    const response = await api.get('/assignments', { params });
    return response.data;
  },
  /** Admin: create one assignment per advisor in advisor_ids (fanout). */
  create: async (data: {
    profile_id: string;
    advisor_ids: string[];
    assigned_date: string;
    target_date: string;
  }): Promise<Assignment[]> => {
    const response = await api.post('/assignments', data);
    return response.data;
  },
  /** Advisor: list my own assignments, grouped today / upcoming / past. */
  listMine: async (): Promise<MyAssignments> => {
    const response = await api.get('/assignments/me');
    return response.data;
  },
  update: async (id: string, data: Partial<{ assigned_date: string; target_date: string; status: AssignmentStatus }>): Promise<Assignment> => {
    const response = await api.patch(`/assignments/${id}`, data);
    return response.data;
  },
  cancel: async (id: string): Promise<void> => {
    await api.delete(`/assignments/${id}`);
  },
};

export default api;
