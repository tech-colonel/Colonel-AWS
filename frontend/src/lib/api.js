import axios from 'axios';

// Resolve the backend base URL at RUNTIME (a function call, so the bundler can't
// constant-fold a wrong value into the build):
//   1. REACT_APP_BACKEND_URL set to a NON-EMPTY value → explicit override (always wins).
//   2. App served from localhost (local dev on :3000) → talk to local backend on :8001.
//   3. Otherwise (served from a tunnel / production, one host serves UI + API) →
//      same-origin relative URLs. Works through Cloudflare, ngrok, etc. with no rebuild.
export function resolveApiUrl() {
  const override = process.env.REACT_APP_BACKEND_URL;
  if (override) return override;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8001';
  return ''; // same-origin
}
export const API_URL = resolveApiUrl();

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
     'ngrok-skip-browser-warning': 'true' 
  }
});

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;