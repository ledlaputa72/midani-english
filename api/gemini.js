import { GoogleGenerativeAI } from '@google/generative-ai'

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = (process.env.VITE_GEMINI_API_KEY ?? '').trim()
  if (!apiKey) {
    return res.status(500).json({ error: 'missing-key' })
  }

  const { prompt } = req.body ?? {}
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' })
  }

  const modelsToTry = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash']
  let lastError = 'unknown'

  for (const modelName of modelsToTry) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey)
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.3 },
      })
      const result = await model.generateContent(prompt)
      const text = result.response.text()
      return res.status(200).json({ text })
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 80) : 'error'
    }
  }

  return res.status(500).json({ error: lastError })
}
