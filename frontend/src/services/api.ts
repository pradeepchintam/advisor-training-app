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
} from '../types';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: attach Bearer token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
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
  list: async (): Promise<SessionPublic[]> => {
    const response = await api.get('/sessions');
    return response.data;
  },
  create: async (persona: Partial<ClientPersona>): Promise<SessionDetail> => {
    const response = await api.post('/sessions', { persona });
    return response.data;
  },
  get: async (id: string): Promise<SessionDetail> => {
    const response = await api.get(`/sessions/${id}`);
    return response.data;
  },
  end: async (id: string): Promise<void> => {
    await api.post(`/sessions/${id}/end`);
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
  list: async (): Promise<Presentation[]> => {
    const response = await api.get('/presentations');
    return response.data;
  },
  getActive: async (): Promise<Presentation | null> => {
    try {
      const response = await api.get('/presentations/active');
      return response.data;
    } catch (err: unknown) {
      // 404 means no active deck — return null instead of throwing
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return null;
      throw err;
    }
  },
  upload: async (title: string, file: File): Promise<Presentation> => {
    const formData = new FormData();
    formData.append('title', title);
    formData.append('file', file);
    // IMPORTANT: do not set Content-Type manually. The browser sets
    // "multipart/form-data; boundary=…" with the correct boundary automatically
    // when passed a FormData body. An explicit "multipart/form-data" *without*
    // the boundary makes the server fail to parse the form.
    const response = await api.post('/presentations', formData);
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

// Text-to-speech via AWS Polly
export const ttsApi = {
  /** Synthesize text to mp3 bytes. Returns an object URL that <audio src> can use. */
  synthesize: async (text: string, gender?: 'male' | 'female' | null): Promise<string> => {
    const response = await api.post('/tts', { text, gender }, { responseType: 'blob' });
    const blob = response.data as Blob;
    return URL.createObjectURL(blob);
  },
};

export default api;
