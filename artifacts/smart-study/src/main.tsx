import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import './index.css';
import 'katex/dist/katex.min.css';

// ── DEBUG: Global fetch interceptor ──────────────────────────────────────────
const _origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.includes('/api/')) {
    const authHdr = (init?.headers as Record<string, string> | undefined)?.Authorization ?? 'NONE';
    console.log(`[FETCH] ▶ ${method} ${url}  Auth:${authHdr !== 'NONE' ? 'Bearer ***' : 'NONE'}`);
    try {
      const res = await _origFetch(input, init);
      const clone = res.clone();
      const ct = res.headers.get('content-type') ?? 'unknown';
      const body = await clone.text();
      console.log(`[FETCH] ◀ ${method} ${url}  STATUS:${res.status}  CT:${ct}`);
      console.log(`[FETCH] BODY(300): ${body.slice(0, 300)}`);
      return res;
    } catch (err) {
      console.error(`[FETCH] ✗ ${method} ${url}  NETWORK ERROR:`, err);
      throw err;
    }
  }
  return _origFetch(input, init);
};
// ─────────────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
