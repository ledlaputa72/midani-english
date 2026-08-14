// Single source of truth for Gemini AI feature gate.
// Fail-safe: disabled unless GEMINI_ENABLED is exactly 'true' AND API key is present.
export const isAiEnabled = () =>
  process.env.GEMINI_ENABLED === 'true' && !!(process.env.VITE_GEMINI_API_KEY ?? '').trim()

export const AI_DISABLED_RESPONSE = {
  error: 'AI 기능이 일시 중지되었습니다.',
  code: 'AI_DISABLED',
}
