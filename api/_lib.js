const UA =
  'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const REDIRECT_TIMEOUT_MS = 8000;

function extractRedirectFromHtml(html) {
  if (!html) return '';
  let m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (m && m[1]) return m[1];
  m = html.match(/(?:window\.location\.href|location\.replace)\s*=\s*["']([^"']+)["']/i);
  if (m && m[1]) return m[1];
  m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i);
  if (m && m[1]) return m[1];
  return '';
}

/**
 * Follow HTTP redirects (and HTML-based client redirects) until we land
 * on a non-short URL. Returns { url, status, ok, error? }.
 */
async function followRedirects(inputUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS);

  try {
    const res = await fetch(inputUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: BROWSER_HEADERS,
      signal: controller.signal,
    });

    let finalUrl = res.url;

    // If we're still on a short URL, TikTok likely served an HTML page
    // (bot check or client-side redirect) instead of an HTTP 3xx.
    if (/^https?:\/\/(vt|vm)\.tiktok\.com\//i.test(finalUrl)) {
      const html = await res.text();
      const fromHtml = extractRedirectFromHtml(html);
      if (fromHtml) finalUrl = fromHtml;
    }

    return { url: finalUrl, status: res.status, ok: true };
  } catch (e) {
    return {
      url: '',
      status: 0,
      ok: false,
      error: String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function classifyOne(input) {
  if (!input || typeof input !== 'string' || !input.trim()) {
    return {
      input,
      kind: 'unknown',
      reason: 'empty url',
      resolved_url: '',
      is_live: null,
      live_username: '',
      error: 'empty url',
    };
  }

  const result = await followRedirects(input.trim());
  const resolvedUrl = result.url || '';
  const fetchError = result.ok ? null : result.error || `HTTP ${result.status}`;

  let kind = 'unknown';
  let reason = '';
  let liveUsername = '';

  if (resolvedUrl) {
    const lower = resolvedUrl.toLowerCase();
    if (lower.includes('/live')) {
      kind = 'live';
      reason = 'resolved URL contains /live';
      const m = resolvedUrl.match(/@([^/?#]+)\/live/i);
      if (m) liveUsername = m[1];
    } else if (lower.includes('/photo/')) {
      kind = 'photo';
      reason = 'resolved URL contains /photo/';
    } else if (lower.includes('/video/')) {
      kind = 'video';
      reason = 'resolved URL contains /video/';
    } else if (lower.includes('tiktok.com')) {
      kind = 'video';
      reason = 'resolved URL is a tiktok.com URL (defaulting to video)';
    } else {
      reason = 'resolved URL is not a TikTok URL';
    }
  } else if (/\/(live|share\/live)\//i.test(input)) {
    kind = 'live';
    reason = 'input URL matches live pattern';
    const m = input.match(/@([^/?#]+)\/live/i);
    if (m) liveUsername = m[1];
  } else if (/\/(video|photo)\/\d+/i.test(input)) {
    kind = 'video';
    reason = 'input URL matches video/photo pattern';
  } else if (fetchError) {
    reason = `fetch failed: ${fetchError}`;
  } else {
    reason = 'could not resolve URL';
  }

  return {
    input,
    kind,
    reason,
    resolved_url: resolvedUrl,
    is_live: kind === 'live' ? true : null,
    live_username: liveUsername,
    error: fetchError,
  };
}

export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function readUrlParam(req) {
  const raw = req.query.url;
  return Array.isArray(raw) ? raw[0] : raw;
}
