// 진단용 엔드포인트: 사용 가능한 모델 목록 확인
export default async function handler(req, res) {
  const apiKey = (process.env.VITE_GEMINI_API_KEY ?? '').trim()

  const result = {
    keyLoaded: Boolean(apiKey),
    keyPrefix: apiKey ? apiKey.slice(0, 10) + '...' : '(empty)',
    keyFormat: apiKey.startsWith('AIza')
      ? 'standard-AIza (OK)'
      : apiKey.startsWith('AQ.')
      ? 'AQ.-token (EXPIRES in 1hr - use AIzaSy key instead!)'
      : `unknown(${apiKey.slice(0, 5)})`,
    tests: [],
  }

  if (!apiKey) {
    return res.status(200).json(result)
  }

  // 모델 목록 조회
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    )
    const body = await r.text()
    // 모델 이름만 추출
    const names = [...body.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1])
    result.tests.push({
      method: 'GET v1beta/models',
      status: r.status,
      modelNames: names.slice(0, 20),
    })
  } catch (e) {
    result.tests.push({ method: 'GET v1beta/models', error: String(e).slice(0, 100) })
  }

  // 실제 generateContent 테스트 (v1beta + v1 각각)
  const testCombos = [
    { version: 'v1beta', model: 'gemini-2.5-flash' },
    { version: 'v1',     model: 'gemini-2.5-flash' },
  ]
  for (const { version, model } of testCombos) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Say "OK" only.' }] }],
          }),
        }
      )
      const body = await r.text()
      result.tests.push({
        method: `POST ${version}/${model}`,
        status: r.status,
        preview: body.slice(0, 200),
      })
    } catch (e) {
      result.tests.push({ method: `POST ${version}/${model}`, error: String(e).slice(0, 100) })
    }
  }

  return res.status(200).json(result)
}
