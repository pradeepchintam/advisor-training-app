/**
 * Extract the most informative error message from any error value.
 * Handles axios errors, validation errors, plain Errors, strings, etc.
 */
export function getErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (!err) return fallback;

  // Axios error shape
  const ax = err as {
    response?: {
      status?: number;
      statusText?: string;
      data?: { detail?: unknown; message?: unknown; error?: unknown };
    };
    request?: unknown;
    message?: string;
    code?: string;
    config?: { url?: string; method?: string };
  };

  // 1. Backend returned a response body
  if (ax.response) {
    const data = ax.response.data;
    const status = ax.response.status ?? 0;
    const url = ax.config?.url ?? '';
    const method = (ax.config?.method ?? 'GET').toUpperCase();

    // FastAPI validation errors: detail is an array of {loc, msg, type}
    if (Array.isArray(data?.detail)) {
      const lines = (data.detail as Array<{ loc?: unknown[]; msg?: string; type?: string }>)
        .map((d) => {
          const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
          return field ? `${field}: ${d.msg}` : d.msg;
        })
        .filter(Boolean)
        .join(' • ');
      return lines ? `Validation error — ${lines}` : `HTTP ${status} on ${method} ${url}`;
    }

    // Simple FastAPI/Flask-style detail string
    if (typeof data?.detail === 'string') return data.detail;
    if (typeof data?.message === 'string') return data.message;
    if (typeof data?.error === 'string') return data.error;

    // Common HTTP status descriptions
    if (status === 401) return 'Not authorized — please sign in again';
    if (status === 403) return 'Access denied — you do not have permission for this action';
    if (status === 404) return `Not found: ${method} ${url}`;
    if (status === 409) return 'Conflict — that record already exists';
    if (status === 422) return 'The data you submitted is invalid';
    if (status >= 500) return `Server error (HTTP ${status}) — check backend logs`;

    return `HTTP ${status} ${ax.response.statusText ?? ''} on ${method} ${url}`.trim();
  }

  // 2. Network error — request was made but no response received
  if (ax.request) {
    if (ax.code === 'ERR_NETWORK') return 'Network error — backend is unreachable. Is it running on port 8081?';
    if (ax.code === 'ECONNABORTED') return 'Request timed out';
    return `Network error: ${ax.message || ax.code || 'no response from server'}`;
  }

  // 3. Plain JavaScript Error
  if (err instanceof Error) return err.message || err.name || fallback;

  // 4. String
  if (typeof err === 'string') return err;

  // 5. Last resort — try to stringify the object meaningfully
  try {
    const s = JSON.stringify(err);
    if (s && s !== '{}') return s;
  } catch {
    // ignore
  }

  return fallback;
}
