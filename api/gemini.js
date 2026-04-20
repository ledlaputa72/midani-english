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
    const maxAttempts = 3  // 503 과부하 시 최대 3회 재시도

    while (attempt < maxAttempts) {
      attempt++
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })

        // 503 과부하: 1초 대기 후 재시도
        if (r.status === 503) {
          const errText = await r.text().catch(() => '')
          const msg = `${version}/${model} http-503 (attempt ${attempt}/${maxAttempts})`
          console.warn(`[gemini] ${msg}`)
          if (attempt < maxAttempts) {
            await sleep(1000 * attempt)  // 1초, 2초 간격으로 재시도
            continue
          }
          errors.push(`${version}/${model} http-503: ${errText.slice(0, 80)}`)
          break
        }

        // 404: 이 모델/버전 조합은 없음 — 바로 다음으로
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

        console.log(`[gemini] ✓ success: ${version}/${model} (attempt ${attempt})`)
        return res.status(200).json({ text })

      } catch (err) {
        const msg = `${version}/${model} exception: ${err instanceof Error ? err.message.slice(0, 60) : 'err'}`
        errors.push(msg)
        console.error(`[gemini] ${msg}`)
        break
      }
    }
  }

  return res.status(500).json({ error: errors.join(' | ') })
}
