import { classifyOne, applyCors } from './_lib.js';

const BATCH_MAX = 5;

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const urls = Array.isArray(payload.urls) ? payload.urls : [];
  if (!urls.length) {
    return res.status(400).json({
      ok: false,
      error: 'expected JSON body {"urls": ["...", "..."]}',
    });
  }

  const truncated = urls.length > BATCH_MAX;
  const slice = urls.slice(0, BATCH_MAX);

  // Parallel keeps us comfortably inside Vercel Hobby's 10s limit.
  const results = await Promise.all(slice.map((u) => classifyOne(u)));

  return res.status(200).json({
    ok: true,
    count: results.length,
    truncated,
    batch_max: BATCH_MAX,
    results,
  });
}
