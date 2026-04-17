// 진단용 엔드포인트: 사용 가능한 모델 목록 확인
export default async function handler(req, res) {
  const apiKey = (process.env.VITE_GEMINI_API_KEY ?? '').trim()

  const result = {
    keyLoaded: Boolean(apiKey),
    keyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : '(empty)',
    keyFormat: apiKey.startsWith('AIza') ? 'legacy(AIza)' : `new(${apiKey.slice(0,3)})`,
    tests: [],
  }

  if (!apiKey) {
    return res.status(200).json(result)
  }

  // 1) key 파라미터 방식으로 모델 목록 조회
  for (const version of ['v1beta', 'v1']) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}`
      )
      const body = await r.text()
      result.tests.push({
        method: `GET ${version}/models?key=`,
        status: r.status,
        preview: body.slice(0, 200),
      })
    } catch (e) {
      result.tests.push({ method: `GET ${version}/models?key=`, error: String(e).slice(0, 80) })
    }
  }

  // 2) Bearer 방식으로 모델 목록 조회
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )
    const body = await r.text()
    result.tests.push({
      method: 'GET v1beta/models Bearer',
      status: r.status,
      preview: body.slice(0, 200),
    })
  } catch (e) {
    result.tests.push({ method: 'GET v1beta/models Bearer', error: String(e).slice(0, 80) })
  }

  return res.status(200).json(result)
}
