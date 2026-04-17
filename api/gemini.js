export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = (process.env.VITE_GEMINI_API_KEY ?? '').trim()
  if (!apiKey) return res.status(500).json({ error: 'missing-key' })

  const { prompt } = req.body ?? {}
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  // API 버전 × 모델명 조합으로 순서대로 시도
  const attempts = [
    { version: 'v1beta', model: 'gemini-2.0-flash' },
    { version: 'v1beta', model: 'gemini-2.0-flash-001' },
    { version: 'v1',     model: 'gemini-2.0-flash' },
    { version: 'v1',     model: 'gemini-2.0-flash-001' },
    { version: 'v1beta', model: 'gemini-1.5-flash' },
    { version: 'v1',     model: 'gemini-1.5-flash' },
    { version: 'v1beta', model: 'gemini-1.5-flash-latest' },
    { version: 'v1beta', model: 'gemini-pro' },
  ]

  let lastError = 'unknown'

  for (const { version, model } of attempts) {
    try {
      const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      })

      if (!r.ok) {
        const errBody = await r.text().catch(() => '')
        lastError = `${version}/${model} → http-${r.status}: ${errBody.slice(0, 80)}`
        console.error(`[gemini] ${version}/${model} failed ${r.status}:`, errBody.slice(0, 200))
        continue
      }

      const data = await r.json()
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')

      if (!text) {
        lastError = `${version}/${model} → empty response`
        continue
      }

      console.log(`[gemini] success with ${version}/${model}`)
      return res.status(200).json({ text, model: `${version}/${model}` })
    } catch (err) {
      lastError = `${version}/${model} → ${err instanceof Error ? err.message.slice(0, 60) : 'error'}`
      console.error(`[gemini] ${version}/${model} exception:`, err)
    }
  }

  return res.status(500).json({ error: lastError })
}
