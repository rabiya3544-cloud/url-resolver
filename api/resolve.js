import { applyCors, readUrlParam } from './_lib.js';

const UA =
  'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = readUrlParam(req);
  if (!url) return res.status(400).json({ ok: false, error: 'missing url parameter' });

  // Resolve short URL first so oEmbed gets a canonical TikTok URL.
  let target = String(url);
  try {
    const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': UA } });
    if (r.url) target = r.url;
  } catch (_) {
    /* continue with original URL */
  }

  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(target)}`;
  try {
    const o = await fetch(oembedUrl, { headers: { 'User-Agent': UA } });
    if (!o.ok) {
      return res.status(502).json({ ok: false, error: `oembed failed: HTTP ${o.status}` });
    }
    const data = await o.json();

    return res.status(200).json({
      ok: true,
      mode: 'video',
      item: {
        id: (target.match(/\/video\/(\d+)/) || [])[1] || '',
        type: 'video',
        title: data.title || '',
        duration: 0,
        author: {
          handle: (data.author_url || '')
            .replace(/^https?:\/\/www\.tiktok\.com\//, '')
            .replace(/\/$/, '') || '',
          name: data.author_name || '',
          avatar: '',
        },
        stats: { plays: null, likes: null, comments: null, shares: null },
        cover: data.thumbnail_url || '',
        video: { noWatermark: '', watermark: '', hd: '' },
        music: {},
        images: [],
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'unexpected error: ' + e.message });
  }
}
