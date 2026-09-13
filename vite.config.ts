import { defineConfig } from 'vite';

// Replit serves the dev server through a proxy on its own domain, so listen on
// every interface and accept any Host header. Harmless locally.
export default defineConfig({
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
});
