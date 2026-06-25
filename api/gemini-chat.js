export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = (process.env.VITE_GEMINI_API_KEY ?? '').trim()
  if (!apiKey) return res.status(500).json({ error: 'missing-key' })

  const { systemInstruction, contents } = req.body ?? {}
  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: 'contents required' })
  }

  const body = JSON.stringify({
    ...(systemInstruction
      ? { system_instruction: { parts: [{ text: systemInstruction }] } }
      : {}),
    contents,
    generationConfig: { temperature: 0.8 },
  })

  // 현재 Google AI Studio에서 실제 작동하는 모델 목록
  // (404 모델 제거, 503 모델은 재시도로 처리)
  const candidates = [
    { version: 'v1beta', model: 'gemini-2.5-flash' },
    { version: 'v1',     model: 'gemini-2.5-flash' },
    { version: 'v1beta', model: 'gemini-2.5-pro' },
    { version: 'v1',     model: 'gemini-2.5-pro' },
    { version: 'v1beta', model: 'gemini-2.5-flash-latest' },
    { version: 'v1',     model: 'gemini-2.5-flash-latest' },
  ]

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const errors = []

  for (const { version, model } of candidates) {
    const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`
    let attempt = 0
    const maxAttempts = 3

    while (attempt < maxAttempts) {
      attempt++
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })

        if (r.status === 503) {
          const errText = await r.text().catch(() => '')
          if (attempt < maxAttempts) {
            await sleep(1000 * attempt)
            continue
          }
          errors.push(`${version}/${model} http-503: ${errText.slice(0, 80)}`)
          break
        }

        if (r.status === 404) {
          const errText = await r.text().catch(() => '')
          errors.push(`${version}/${model} http-404: ${errText.slice(0, 80)}`)
          break
        }

        if (!r.ok) {
          const errText = await r.text().catch(() => '')
          errors.push(`${version}/${model} http-${r.status}: ${errText.slice(0, 80)}`)
          break
        }

        const data = await r.json()
        const text = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? '').join('')

        if (!text) {
          errors.push(`${version}/${model} empty-response`)
          break
        }

        return res.status(200).json({ text })

      } catch (err) {
        errors.push(`${version}/${model} exception: ${err instanceof Error ? err.message.slice(0, 60) : 'err'}`)
        break
      }
    }
  }

  return res.status(500).json({ error: errors.join(' | ') })
}
