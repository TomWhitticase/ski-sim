/**
 * Serves resort data from the private R2 bucket, read-only.
 *
 * Every request is at most one R2 read (a Class B operation): no listing, no writes, and
 * anything that isn't a plain file path is refused before the bucket is touched, so
 * junk traffic costs nothing but a Worker request (which the Free plan caps).
 */

interface Env {
  DATA: R2Bucket;
  ALLOWED_ORIGINS: string;
}

/** `<resort>/<file>` or `resorts.json`: lowercase ids, simple file names. */
const KEY = /^(?:[a-z0-9-]+\/[A-Za-z0-9._-]+|resorts\.json)$/;

const TYPES: Record<string, string> = {
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  bin: 'application/octet-stream',
};

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed =
    env.ALLOWED_ORIGINS.split(',').includes(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...headers, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' },
      });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });

    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!KEY.test(key) || key.includes('..')) return new Response('Not found', { status: 404, headers });

    const object = await env.DATA.get(key, { onlyIf: request.headers });
    if (!object) return new Response('Not found', { status: 404, headers });

    const out = new Headers(headers);
    object.writeHttpMetadata(out);
    out.set('ETag', object.httpEtag);
    if (!out.has('Content-Type')) {
      out.set('Content-Type', TYPES[key.split('.').pop() ?? ''] ?? 'application/octet-stream');
    }
    // Manifests and the index revalidate on every load; everything else is fetched with
    // ?v=<build time> (resortUrl), so the browser keeps it for a day.
    if (!out.has('Cache-Control')) {
      out.set(
        'Cache-Control',
        key === 'resorts.json' || key.endsWith('/manifest.json') ? 'no-cache' : 'public, max-age=86400',
      );
    }
    // A conditional GET that matched: R2 returns the metadata without a body.
    if (!('body' in object)) return new Response(null, { status: 304, headers: out });
    return new Response(object.body, { headers: out });
  },
} satisfies ExportedHandler<Env>;
