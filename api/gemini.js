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

  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash']
  let lastError = 'unknown'

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
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
        lastError = `http-${r.status}(${model}): ${errBody.slice(0, 100)}`
        console.error(`[gemini] ${model} failed ${r.status}:`, errBody.slice(0, 200))
        continue
      }

      const data = await r.json()
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
      return res.status(200).json({ text })
    } catch (err) {
      lastError = `${model}: ${err instanceof Error ? err.message : 'error'}`
      console.error(`[gemini] ${model} exception:`, err)
    }
  }

  return res.status(500).json({ error: lastError })
}
