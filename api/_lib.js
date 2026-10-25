const UA =
  'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const REDIRECT_TIMEOUT_MS = 8000;
const TWITTER_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ */
/*  TikTok helpers (unchanged)                                        */
/* ------------------------------------------------------------------ */

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

async function classifyTikTok(input) {
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
    } else if (lower.includes('/music/')) {
      kind = 'music';
      reason = 'resolved URL contains /music/ (sound page)';
    } else if (isTikTokProfileUrl(resolvedUrl)) {
      kind = 'profile';
      reason = 'resolved URL matches a TikTok profile (/@handle with no media segment)';
    } else if (lower.includes('tiktok.com')) {
      kind = 'unknown';
      reason = 'resolved URL is a tiktok.com page but not a recognised profile, video, photo, live, or music URL';
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
/* Add this helper anywhere above classifyTikTok() */
function isTikTokProfileUrl(url) {
  try {
    const path = new URL(url).pathname; // e.g. "/@nahommedia" or "/@nahommedia/"
    return /^\/@[A-Za-z0-9._]+\/?$/.test(path);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Twitter / X helpers                                               */
/* ------------------------------------------------------------------ */

const TWITTER_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

function isTwitterUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return TWITTER_HOSTS.has(host);
  } catch {
    return false;
  }
}

function extractTweetId(u) {
  // Matches /username/status/1234567890 and /i/web/status/1234567890
  const m = u.match(/\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : '';
}

/** X's own embed widget token formula. */
function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '');
}

function pickTweetMedia(tweet) {
  // 1️⃣ Check the top-level `video` property (used for some video tweets)
  if (tweet.video) {
    const v = tweet.video;
    // The video object may contain video_info.variants directly, or be nested
    const variants = v.video_info?.variants || v.variants || [];
    const bestUrl = pickBestVariant({ video_info: { variants } });
    if (bestUrl) {
      return {
        kind: 'video',
        reason: 'tweet.video contains video variants',
        url: v.poster || v.thumbnail_url || '',
        videoUrl: bestUrl,
      };
    }
  }

  // 2️⃣ Fall back to mediaDetails (the common case)
  const media = Array.isArray(tweet.mediaDetails) ? tweet.mediaDetails : [];
  if (!media.length) {
    return { kind: 'text', reason: 'tweet contains no media (mediaDetails empty)' };
  }

  const video = media.find((m) => m.type === 'video');
  if (video) {
    return {
      kind: 'video',
      reason: 'tweet mediaDetails contains a video',
      url: video.media_url_https || video.media_url || '',
      videoUrl: pickBestVariant(video),
    };
  }

  const gif = media.find((m) => m.type === 'animated_gif');
  if (gif) {
    return {
      kind: 'video',
      reason: 'tweet mediaDetails contains an animated_gif',
      url: gif.media_url_https || gif.media_url || '',
      videoUrl: pickBestVariant(gif),
    };
  }

  const photo = media.find((m) => m.type === 'photo');
  if (photo) {
    return {
      kind: 'photo',
      reason: 'tweet mediaDetails contains a photo',
      url: photo.media_url_https || photo.media_url || '',
      videoUrl: '',
    };
  }

  return { kind: 'unknown', reason: 'tweet mediaDetails has an unrecognised type' };
}

function pickBestVariant(media) {
  const variants = media?.video_info?.variants;
  if (!Array.isArray(variants) || !variants.length) return '';
  // Highest bitrate mp4 first, fall back to first variant.
  const mp4 = variants
    .filter((v) => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0]?.url || variants[0]?.url || '';
}

async function classifyTwitter(input) {
  const tweetId = extractTweetId(input);
  if (!tweetId) {
    return {
      input,
      kind: 'unknown',
      reason: 'could not extract tweet ID from URL',
      resolved_url: input,
      is_live: null,
      live_username: '',
      error: 'missing tweet id',
    };
  }

  const token = syndicationToken(tweetId);
  const apiUrl =
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}` +
    `&token=${encodeURIComponent(token)}&lang=en`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TWITTER_TIMEOUT_MS);

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': 'https://platform.twitter.com/',
        'Origin': 'https://platform.twitter.com',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        input,
        kind: 'unknown',
        reason: `syndication API returned HTTP ${res.status}`,
        resolved_url: input,
        is_live: null,
        live_username: '',
        error: `HTTP ${res.status}`,
      };
    }

    const tweet = await res.json();
    const media = pickTweetMedia(tweet);

    // Try to canonicalise the URL using the tweet author + id when available.
    const user = tweet.user?.screen_name;
    const resolvedUrl = user
      ? `https://x.com/${user}/status/${tweetId}`
      : input;

    return {
      input,
      kind: media.kind,
      reason: media.reason,
      resolved_url: resolvedUrl,
      is_live: null,
      live_username: '',
      error: null,
      // Extra fields (safe to ignore; your current frontend will just not show them)
      media_url: media.url || '',
      video_url: media.videoUrl || '',
    };
  } catch (e) {
    return {
      input,
      kind: 'unknown',
      reason: `twitter fetch failed: ${String(e && e.message) || e}`,
      resolved_url: input,
      is_live: null,
      live_username: '',
      error: String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

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

  const trimmed = input.trim();

  if (isTwitterUrl(trimmed)) {
    return classifyTwitter(trimmed);
  }

  // Default: TikTok
  return classifyTikTok(trimmed);
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
