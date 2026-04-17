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

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 },
  })

  // 시도할 모델 목록 (현재 Google AI Studio에서 지원하는 모델)
  const models = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
    'gemini-1.5-pro-latest',
  ]

  const errors = []

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      if (!r.ok) {
        const errText = await r.text().catch(() => '')
        const msg = `${model} http-${r.status}: ${errText.slice(0, 120)}`
        errors.push(msg)
        console.error(`[gemini] ${msg}`)
        continue
      }

      const data = await r.json()
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '').join('')

      if (!text) {
        errors.push(`${model} empty-response`)
        continue
      }

      console.log(`[gemini] ✓ success: ${model}`)
      return res.status(200).json({ text })
    } catch (err) {
      const msg = `${model} exception: ${err instanceof Error ? err.message.slice(0, 60) : 'err'}`
      errors.push(msg)
      console.error(`[gemini] ${msg}`)
    }
  }

  return res.status(500).json({ error: errors.join(' | ') })
}
