/*
 * KelpSpotter import proxy — a Cloudflare Worker.
 *
 * Exists for one reason: Google's KML endpoints send no Access-Control-Allow-Origin
 * header, so a browser cannot read them however the request is shaped. This relays
 * the fetch server-side and returns the bytes with CORS headers attached.
 *
 * It is deliberately NOT a general-purpose proxy. Requests are restricted to an
 * explicit host allowlist — an open relay would let anyone route arbitrary traffic
 * through this account, and would eventually be found and abused.
 *
 * The app calls it via PROXY_URL in js/config.js; when that is unset the app falls
 * back to a direct fetch and, failing that, tells the user to export the KML by
 * hand. So the proxy is an enhancement, never a dependency.
 */

const ALLOW = [
  /^https:\/\/www\.google\.com\/maps\/d\//i,      // My Maps (kml / viewer / edit)
  /^https:\/\/earth\.google\.com\//i,             // Earth projects
  /^https:\/\/drive\.google\.com\//i,             // KML/KMZ parked in Drive
  /^https:\/\/maps\.app\.goo\.gl\//i,             // short links (resolved by redirect)
  /^https:\/\/goo\.gl\/maps\//i
];

const MAX_BYTES = 8 * 1024 * 1024;   // KMZ of any sane size fits well inside this
const TIMEOUT_MS = 20000;

function cors(origin, allowed) {
  const h = {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  return h;
}

const fail = (status, message, headers) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
  });

/*
 * Turn a share URL into something that actually returns KML.
 *
 * My Maps is the case worth handling: the URL a user copies is the *viewer*,
 * which serves HTML, while the same map is available as KML from /maps/d/kml
 * with the same mid. forcekml=1 asks for KML rather than a KMZ network link,
 * which saves the client an unzip.
 */
export function normalize(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return { error: 'not a URL' }; }

  if (/^https:\/\/www\.google\.com\/maps\/d\//i.test(u.href)) {
    const mid = u.searchParams.get('mid');
    if (!mid) return { error: 'that My Maps link has no map id (mid) in it' };
    return { url: 'https://www.google.com/maps/d/kml?forcekml=1&mid=' + encodeURIComponent(mid) };
  }

  /*
   * Earth projects have no documented KML export endpoint — the web UI uses an
   * internal one that is unversioned and would break without notice. Rather than
   * ship something that fails mysteriously later, say so now and point at the
   * export that does work.
   */
  if (/^https:\/\/earth\.google\.com\//i.test(u.href)) {
    return {
      error: 'Google Earth projects have no stable KML export URL. ' +
             'Open the project, choose Project → Export as KML file, then import that file.'
    };
  }

  return { url: u.href };
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || 'https://jpagett.github.io,http://localhost:8000')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return fail(405, 'GET only', headers);

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return fail(400, 'missing ?url=', headers);

    const norm = normalize(target);
    if (norm.error) return fail(400, norm.error, headers);
    if (!ALLOW.some((re) => re.test(norm.url))) {
      return fail(403, 'that host is not on this proxy’s allowlist', headers);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(norm.url, {
        redirect: 'follow',                 // short links resolve here
        signal: ctrl.signal,
        headers: { 'User-Agent': 'KelpSpotter-import/1.0' }
      });
    } catch (err) {
      clearTimeout(timer);
      return fail(502, 'upstream fetch failed: ' + (err && err.message || err), headers);
    }
    clearTimeout(timer);

    if (!upstream.ok) return fail(502, 'upstream returned HTTP ' + upstream.status, headers);

    const len = Number(upstream.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return fail(413, 'file larger than 8 MB', headers);

    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return fail(413, 'file larger than 8 MB', headers);

    /*
     * A Maps share link that resolves to HTML is the saved-list case: the places
     * are rendered by script and are simply not in this document, so returning it
     * would hand the importer something it can never parse. Name the reason.
     */
    const ctype = upstream.headers.get('Content-Type') || '';
    if (/text\/html/i.test(ctype)) {
      return fail(422,
        'That link returns a web page, not KML. Google Maps saved lists cannot be ' +
        'exported this way — use Google Takeout, or save the places to My Maps ' +
        'and share that instead.', headers);
    }

    return new Response(buf, {
      status: 200,
      headers: Object.assign({}, headers, {
        'Content-Type': ctype || 'application/vnd.google-earth.kml+xml',
        'Cache-Control': 'public, max-age=300'
      })
    });
  }
};
