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

  const candidates = [
    { version: 'v1beta', model: 'gemini-2.5-flash-preview-tts' },
    { version: 'v1beta', model: 'gemini-2.5-pro-preview-tts' },
  ]

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

  return res.status(500).json({ error: errors.join(' | ') })
}
