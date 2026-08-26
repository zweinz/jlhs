import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

type EdgeHandler = (request: Request) => Promise<Response>;

async function apiHandler(pathname: string): Promise<EdgeHandler | undefined> {
  if (pathname === '/api/resolve-map-link') return (await import('./api/resolve-map-link')).default;
  if (pathname === '/api/solo/start') return (await import('./api/solo/start')).default;
  if (pathname === '/api/solo/question') return (await import('./api/solo/question')).default;
  if (pathname === '/api/solo/card-event') return (await import('./api/solo/card-event')).default;
  if (pathname === '/api/solo/clock') return (await import('./api/solo/clock')).default;
  if (pathname === '/api/solo/check-location') return (await import('./api/solo/check-location')).default;
  if (pathname === '/api/solo/reveal') return (await import('./api/solo/reveal')).default;
  if (pathname === '/api/solo/photo') return (await import('./api/solo/photo')).default;
  if (pathname === '/api/solo/street-orientation') return (await import('./api/solo/street-orientation')).default;
  return undefined;
}

function localEdgeApi(): Plugin {
  return {
    name: 'local-edge-api',
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        try {
          const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
          const handler = await apiHandler(url.pathname);
          if (!handler) {
            next();
            return;
          }
          const chunks: Uint8Array[] = [];
          for await (const chunk of incoming) {
            chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
          }
          const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const body = size > 0 ? new Uint8Array(size) : undefined;
          if (body) {
            let offset = 0;
            chunks.forEach((chunk) => { body.set(chunk, offset); offset += chunk.byteLength; });
          }
          const headers = new Headers();
          Object.entries(incoming.headers).forEach(([name, value]) => {
            if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
            else if (value !== undefined) headers.set(name, value);
          });
          const request = new Request(`http://127.0.0.1${incoming.url}`, {
            method: incoming.method,
            headers,
            body: ['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? undefined : body,
          });
          const response = await handler(request);
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => outgoing.setHeader(name, value));
          outgoing.end(new Uint8Array(await response.arrayBuffer()));
        } catch (error) {
          outgoing.statusCode = 500;
          outgoing.setHeader('content-type', 'application/json');
          outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Local API request failed.' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  ['GOOGLE_MAPS_SERVER_API_KEY', 'GEMINI_API_KEY', 'SOLO_SESSION_SECRET', 'SOLO_SESSION_SECRET_PREVIOUS'].forEach((name) => {
    if (env[name] && !process.env[name]) process.env[name] = env[name];
  });
  return {
    plugins: [react(), localEdgeApi()],
    test: { environment: 'node' },
  };
});
