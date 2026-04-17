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

  // AIzaSy... 형식 → ?key= 파라미터 방식
  // AQ. 등 신규 형식 → Authorization: Bearer 방식도 함께 시도
  const isLegacyKey = apiKey.startsWith('AIza')

  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-1.5-flash', 'gemini-1.5-flash-latest']
  const versions = ['v1beta', 'v1']

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 },
  })

  let lastError = 'unknown'

  for (const version of versions) {
    for (const model of models) {
      // 각 모델별로 key 파라미터 방식 / Bearer 방식 순서로 시도
      const authModes = isLegacyKey
        ? ['key-param']               // AIzaSy: key 파라미터만
        : ['bearer', 'key-param']     // 신규 키: Bearer 먼저, fallback으로 key 파라미터

      for (const authMode of authModes) {
        try {
          const baseUrl = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent`
          const url = authMode === 'key-param' ? `${baseUrl}?key=${apiKey}` : baseUrl
          const headers = { 'Content-Type': 'application/json' }
          if (authMode === 'bearer') headers['Authorization'] = `Bearer ${apiKey}`

          const r = await fetch(url, { method: 'POST', headers, body })

          if (!r.ok) {
            const errText = await r.text().catch(() => '')
            lastError = `${version}/${model}(${authMode}) http-${r.status}: ${errText.slice(0, 60)}`
            console.error(`[gemini] ${lastError}`)
            continue
          }

          const data = await r.json()
          const text = (data.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? '').join('')

          if (!text) {
            lastError = `${version}/${model}(${authMode}) empty-response`
            continue
          }

          console.log(`[gemini] ✓ success: ${version}/${model}(${authMode})`)
          return res.status(200).json({ text })
        } catch (err) {
          lastError = `${version}/${model}(${authMode}) exception: ${err instanceof Error ? err.message.slice(0, 40) : 'err'}`
          console.error(`[gemini] ${lastError}`)
        }
      }
    }
  }

  return res.status(500).json({ error: lastError })
}
