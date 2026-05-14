import axios from 'axios';
import type {
  User,
  AdvisorWithStats,
  SessionPublic,
  SessionDetail,
  SessionAnalysis,
  ClientPersona,
  QuestionnaireContent,
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
  update: async (id: string, data: Partial<User>): Promise<User> => {
    const response = await api.put(`/advisors/${id}`, data);
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
    await api.post(`/sessions/${id}/recording`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
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

export default api;
