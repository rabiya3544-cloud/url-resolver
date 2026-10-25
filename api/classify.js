import { classifyOne, applyCors, readUrlParam } from './_lib.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = readUrlParam(req);
  if (!url) {
    return res.status(400).json({
      ok: false,
      error: 'missing url parameter. Usage: /api/classify?url=<tiktok_url>',
    });
  }

  const result = await classifyOne(String(url));
  return res.status(200).json({ ...result, ok: true });
}
