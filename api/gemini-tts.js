function pcmToWav(pcmBuffer, sampleRate, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmBuffer.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcmBuffer.length, 40)
  return Buffer.concat([header, pcmBuffer])
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = (process.env.VITE_GEMINI_API_KEY ?? '').trim()
  if (!apiKey) return res.status(500).json({ error: 'missing-key' })

  const { text, voice } = req.body ?? {}
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' })
  }

  const voiceName = voice || 'Charon'

  const body = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
  })

  // 하드코딩한 모델명이 이 API 키/프로젝트에서 실제로 활성화돼 있지 않으면 매번 조용히
  // 실패한다. 먼저 계정에서 실제로 쓸 수 있는 모델 목록을 조회해 이름에 "tts"가 들어간
  // 모델을 우선 후보로 넣고, 혹시 그 목록 조회마저 실패하면 알려진 이름들로 폴백한다.
  const fallbackCandidates = [
    { version: 'v1beta', model: 'gemini-2.5-flash-preview-tts' },
    { version: 'v1beta', model: 'gemini-2.5-pro-preview-tts' },
    { version: 'v1beta', model: 'gemini-2.0-flash-preview-tts' },
  ]

  const discovered = []
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
    if (listRes.ok) {
      const listData = await listRes.json()
      for (const m of listData.models ?? []) {
        const name = m.name?.replace(/^models\//, '')
        if (name && /tts/i.test(name) && (m.supportedGenerationMethods ?? []).includes('generateContent')) {
          discovered.push({ version: 'v1beta', model: name })
        }
      }
    }
  } catch {
    // 목록 조회 실패는 무시하고 아래 폴백 후보로 진행한다.
  }

  const seen = new Set()
  const candidates = [...discovered, ...fallbackCandidates].filter(({ version, model }) => {
    const key = `${version}/${model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const errors = []

  for (const { version, model } of candidates) {
    const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      if (!r.ok) {
        const errText = await r.text().catch(() => '')
        errors.push(`${version}/${model} http-${r.status}: ${errText.slice(0, 100)}`)
        continue
      }

      const data = await r.json()
      const part = data.candidates?.[0]?.content?.parts?.[0]
      const base64Pcm = part?.inlineData?.data
      const mimeType = part?.inlineData?.mimeType ?? ''

      if (!base64Pcm) {
        errors.push(`${version}/${model} empty-audio`)
        continue
      }

      const rateMatch = mimeType.match(/rate=(\d+)/)
      const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000

      const pcmBuffer = Buffer.from(base64Pcm, 'base64')
      const wavBuffer = pcmToWav(pcmBuffer, sampleRate)

      return res.status(200).json({ audio: wavBuffer.toString('base64'), mime: 'audio/wav' })
    } catch (err) {
      errors.push(`${version}/${model} exception: ${err instanceof Error ? err.message.slice(0, 80) : 'err'}`)
    }
  }

  console.error('gemini-tts all candidates failed:', errors.join(' | '))
  return res.status(500).json({ error: errors.join(' | ') })
}
