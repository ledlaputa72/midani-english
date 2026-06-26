import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

// ── Gemini 서버리스 프록시 호출 ──────────────────────────────
// 브라우저에서 @google/generative-ai로 직접 호출하면 API 키 제한으로 실패하므로,
// OCR 기능과 동일하게 /api/gemini-chat 서버리스 함수를 통해 호출한다.
type GeminiContent = { role: 'user' | 'model'; parts: { text: string }[] }

async function callGeminiChat(systemInstruction: string, contents: GeminiContent[]): Promise<string> {
  const res = await fetch('/api/gemini-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction, contents }),
  })
  const data = await res.json()
  if (!res.ok || !data.text) throw new Error(data.error || 'gemini-chat-failed')
  return data.text as string
}

// ── 패턴 카테고리 정의 ──────────────────────────────────────
const PATTERN_CATEGORIES = [
  {
    id: 'A',
    label: 'A. 동의·반응',
    color: '#065f46',
    patterns: [
      { en: 'You know', ko: '있잖아' },
      { en: 'I mean', ko: '내 말은' },
      { en: 'I think', ko: '내 생각엔' },
      { en: 'I know', ko: '알아' },
      { en: "That's right", ko: '맞아요' },
      { en: 'Kind of / Sort of', ko: '어느 정도 / 그런 셈이지' },
      { en: 'I see', ko: '그렇구나' },
      { en: 'Exactly', ko: '정확해' },
      { en: 'That makes sense', ko: '말이 되네' },
      { en: 'Fair enough', ko: '그럴 만하네' },
    ],
  },
  {
    id: 'B',
    label: 'B. 의견·생각',
    color: '#312e81',
    patterns: [
      { en: 'I think that~', ko: '~라고 생각해' },
      { en: 'I feel like~', ko: '~인 것 같아' },
      { en: 'I guess~', ko: '~인 것 같아 (추측)' },
      { en: "I'm not sure~", ko: '잘 모르겠어~' },
      { en: 'To be honest~', ko: '솔직히 말하면~' },
      { en: 'Actually~', ko: '사실은~' },
      { en: 'Honestly~', ko: '진짜로~' },
      { en: 'The thing is~', ko: '문제는~' },
      { en: 'I was thinking~', ko: '~할까 생각했어' },
      { en: 'It seems like~', ko: '~인 것처럼 보여' },
    ],
  },
  {
    id: 'C',
    label: 'C. 질문 패턴',
    color: '#92400e',
    patterns: [
      { en: 'Do you~?', ko: '~해?' },
      { en: 'What do you~?', ko: '뭘 ~해?' },
      { en: 'How do you~?', ko: '어떻게 ~해?' },
      { en: 'Did you~?', ko: '~했어?' },
      { en: 'Are you~?', ko: '~야?' },
      { en: 'Can you~?', ko: '~할 수 있어?' },
      { en: 'Could you~?', ko: '~해줄 수 있어요? (공손)' },
      { en: 'Have you ever~?', ko: '~해본 적 있어?' },
      { en: 'Would you~?', ko: '~할래요? (공손)' },
      { en: "Why don't we~?", ko: '우리 ~할까?' },
      { en: "What's going on?", ko: '무슨 일이야?' },
      { en: 'What happened?', ko: '무슨 일 있었어?' },
      { en: 'What do you mean?', ko: '그게 무슨 말이야?' },
      { en: 'How was~?', ko: '~어땠어?' },
      { en: 'What are you~?', ko: '뭐 ~해?' },
    ],
  },
  {
    id: 'D',
    label: 'D. 부정·불확실',
    color: '#9f1239',
    patterns: [
      { en: "I don't~", ko: '~안 해' },
      { en: "I don't know", ko: '몰라' },
      { en: "I can't~", ko: '~못해' },
      { en: "I don't think~", ko: '~라고 생각 안 해' },
      { en: "That's not~", ko: '그건 ~아니야' },
      { en: "It's not like~", ko: '꼭 ~인 건 아니야' },
      { en: "I'm not really~", ko: '별로 ~안 해' },
      { en: 'Not really', ko: '별로' },
      { en: "It doesn't matter", ko: '상관없어' },
      { en: 'I have no idea', ko: '전혀 모르겠어' },
    ],
  },
  {
    id: 'E',
    label: 'E. 제안·요청',
    color: '#155e75',
    patterns: [
      { en: "Let's~", ko: '~하자' },
      { en: 'I want to~', ko: '~하고 싶어' },
      { en: 'I need to~', ko: '~해야 해' },
      { en: 'I was wondering if~', ko: '혹시 ~할 수 있을까 해서' },
      { en: 'Would you mind~?', ko: '~해도 괜찮을까요?' },
      { en: 'Do you want to~?', ko: '~할래?' },
      { en: 'How about~?', ko: '~는 어때?' },
      { en: 'What if~?', ko: '만약 ~라면?' },
      { en: 'You should~', ko: '~해야 해 (조언)' },
      { en: "Why don't you~?", ko: '~해보는 건 어때?' },
    ],
  },
  {
    id: 'F',
    label: 'F. 시간·상황',
    color: '#5b21b6',
    patterns: [
      { en: "I'm going to~", ko: '~할 거야' },
      { en: 'I was~ing', ko: '~하고 있었어' },
      { en: "I've been~ing", ko: '계속 ~해왔어' },
      { en: 'I used to~', ko: '예전에 ~했었어' },
      { en: "I'm about to~", ko: '막 ~하려던 참이야' },
      { en: "I'll~", ko: '~할게' },
      { en: 'At the end of the day', ko: '결국에는' },
      { en: 'By the way', ko: '그런데' },
      { en: 'Right now', ko: '지금 당장' },
      { en: 'All the time', ko: '항상' },
    ],
  },
  {
    id: 'G',
    label: 'G. 감정·강조',
    color: '#9a3412',
    patterns: [
      { en: 'Oh my God', ko: '어머나' },
      { en: "That's so~", ko: '완전 ~하다' },
      { en: "I'm so~", ko: '나 너무 ~해' },
      { en: 'No way!', ko: '말도 안 돼!' },
      { en: 'Are you serious?', ko: '진심이야?' },
      { en: "It's such a~", ko: '완전 ~야' },
      { en: "That's crazy", ko: '말도 안 돼 / 대단해' },
      { en: "I'm sorry~", ko: '~라서 안타까워 / 미안해' },
      { en: "I can't believe~", ko: '~라니 믿을 수가 없어' },
      { en: 'What a~', ko: '완전 ~네' },
    ],
  },
  {
    id: 'H',
    label: 'H. 대화 연결',
    color: '#1e293b',
    patterns: [
      { en: 'So~', ko: '그래서~' },
      { en: 'And then~', ko: '그리고 나서~' },
      { en: 'I mean~ (재확인)', ko: '내 말은~ (다시 설명)' },
      { en: 'Well~', ko: '음~' },
      { en: 'Anyway~', ko: '아무튼~' },
      { en: 'Speaking of~', ko: '~말이 나와서 말인데' },
      { en: 'On top of that~', ko: '게다가~' },
      { en: 'Either way~', ko: '어느 쪽이든~' },
      { en: 'I mean, honestly~', ko: '솔직히 말해서~' },
      { en: 'Let me know', ko: '알려줘' },
    ],
  },
  {
    id: 'I',
    label: 'I. 구어체',
    color: '#166534',
    patterns: [
      { en: 'I gotta~', ko: '~해야 해 (구어)' },
      { en: 'Wanna~', ko: '~하고 싶어? (구어)' },
      { en: 'Gonna~', ko: '~할 거야 (구어)' },
      { en: 'I know, right?', ko: '그렇지?' },
      { en: "That's what I'm saying", ko: '내 말이 그 말이야' },
      { en: "What's up?", ko: '요즘 어때? / 무슨 일이야?' },
      { en: 'Hang on~', ko: '잠깐만~' },
      { en: 'Come on~', ko: '왜 이래 / 어서' },
      { en: 'Never mind', ko: '신경 쓰지 마' },
      { en: "Don't worry about it", ko: '걱정하지 마' },
      { en: "It's up to you", ko: '너한테 맡길게' },
      { en: 'I totally~', ko: '완전 ~해' },
      { en: 'You know what?', ko: '그거 알아?' },
      { en: 'Go ahead', ko: '그렇게 해 / 먼저 해' },
      { en: 'My bad', ko: '내 잘못이야' },
    ],
  },
]

type PracticeMode = 'free' | 'correct'

// ── 단어장 연동 카테고리 (Vocabulary / Expression / Idiom) ─────────
type StudyKind = 'vocab' | 'expression' | 'idiom'

type StudyListItem = {
  phrase: string
  translation: string
  itemType: 'vocabulary' | 'expression' | 'idiom'
  frequency?: 1 | 2 | 3 | 4 | 5 // 1=드묾 ~ 5=매우 빈번
}

type StudyCategory = {
  id: string
  label: string
  color: string
  kind: StudyKind
  patterns: { en: string; ko: string }[]
  totalCount: number
}

const STUDY_SAMPLE_SIZE = 12

const STUDY_KIND_META: Record<StudyKind, { id: string; label: string; color: string; itemType: StudyListItem['itemType'] }> = {
  vocab: { id: 'V', label: 'V. 내 단어장 (Vocabulary)', color: '#0e7490', itemType: 'vocabulary' },
  expression: { id: 'X', label: 'X. 내 표현 (Expression)', color: '#a21caf', itemType: 'expression' },
  idiom: { id: 'Y', label: 'Y. 내 숙어 (Idiom)', color: '#b91c1c', itemType: 'idiom' },
}

// 사용빈도(frequency) 높은 순으로 정렬 후 상위 N개를 선택한다.
// frequency 미설정 항목은 중간값(3)으로 취급해 너무 뒤로 밀리지 않게 한다.
function pickByFrequency(items: StudyListItem[], count: number): StudyListItem[] {
  return [...items]
    .sort((a, b) => (b.frequency ?? 3) - (a.frequency ?? 3))
    .slice(0, count)
}

function buildStudyCategories(studyItems: StudyListItem[]): StudyCategory[] {
  return (Object.keys(STUDY_KIND_META) as StudyKind[]).map((kind) => {
    const meta = STUDY_KIND_META[kind]
    const matched = studyItems.filter((item) => item.itemType === meta.itemType)
    const sample = pickByFrequency(matched, STUDY_SAMPLE_SIZE)
    return {
      id: meta.id,
      label: meta.label,
      color: meta.color,
      kind,
      patterns: sample.map((item) => ({ en: item.phrase, ko: item.translation })),
      totalCount: matched.length,
    }
  })
}

// ── 시스템 프롬프트 생성 ─────────────────────────────────────
function buildSystemPrompt(
  categoryId: string,
  patterns: string[],
  mode: PracticeMode,
  kind?: StudyKind,
): string {
  const modeRules =
    mode === 'correct'
      ? `- After EVERY one of my responses, check it for grammar or word-choice mistakes, but be lenient — only flag something if it would sound clearly unnatural to a native speaker. Minor, harmless differences are NOT mistakes.
- If I made a real mistake: do NOT continue the topic this turn. Instead, reply with ONLY: a corrected, natural version of what I said (clearly marked, e.g. "More natural: \\"<corrected sentence>\\""), followed by a one-line question asking "Want to repeat it once, or move on to the next part?"
- Wait for my reply. Grade my repeat leniently — accept it as a successful shadow if it captures most of the key words and meaning, even with small differences in word order, articles, or pronunciation (don't require a perfect word-for-word match). Briefly praise me and continue the conversation topic with a new question. If I say "next", "move on", or "다음", continue the topic immediately without further correction practice.
- If I made NO real mistake: continue the conversation naturally, no correction needed.`
      : `- Do NOT interrupt or correct mid-conversation. Wait until I say "feedback" to give corrections.
- If I say "feedback", summarize: which patterns I used, which I missed, and one tip.`

  const goalByKind: Record<StudyKind | 'pattern', string> = {
    pattern: `Your goal is to naturally use and encourage these specific English patterns in our conversation:
${patterns.map((p, i) => `${i + 1}. "${p}"`).join('\n')}
- Naturally weave the target patterns into your own sentences when appropriate.
- When I use a pattern correctly, briefly acknowledge it or just continue naturally.`,
    vocab: `These are words from my personal vocabulary list:
${patterns.map((p, i) => `${i + 1}. "${p}"`).join('\n')}
- Pick conversation TOPICS that relate to the MEANING of these words (e.g. if the word is "budget", talk about money/spending). You don't need me to literally say the word — the goal is exposure through topical conversation.
- When natural, you can use the word yourself in context so I hear it used correctly.`,
    expression: `These are expressions from my personal study list:
${patterns.map((p, i) => `${i + 1}. "${p}"`).join('\n')}
- Try to create situations in the conversation where I would naturally want to use one of these expressions (as-is or slightly modified/conjugated).
- You can also use these expressions yourself in context so I hear them used naturally, and gently invite me to try one.`,
    idiom: `These are idioms from my personal study list:
${patterns.map((p, i) => `${i + 1}. "${p}"`).join('\n')}
- Bring up everyday topics/situations where one of these idioms would fit naturally, and use it yourself in context so I hear it used correctly.
- Gently encourage me to try using one of these idioms when the topic fits, without forcing it.`,
  }

  return `You are my American friend having a casual, natural conversation with me in English.

${goalByKind[kind ?? 'pattern']}

Rules:
- Keep each response SHORT — 2 to 3 sentences max. I need to respond quickly.
- Speak like a real friend, not a teacher. Natural and casual.
${modeRules}
- If I say "next" or "다음", switch to a new conversation topic.
- If I say "stop" or "그만", end the session warmly.
- Start the conversation naturally — introduce a topic and invite me to respond.
- Category focus: ${categoryId}`
}

// ── 영→한 번역 (대화 메시지용) ───────────────────────────────
async function translateToKorean(text: string): Promise<string> {
  return callGeminiChat(
    'Translate the following English sentence into natural, concise Korean. Reply with ONLY the Korean translation — no quotes, no extra commentary.',
    [{ role: 'user', parts: [{ text }] }],
  )
}

// ── 교정 모드: AI 응답에서 "More natural: ..." 추천 문장 추출 ────
function extractCorrection(aiText: string): string | null {
  const m = aiText.match(/More natural:\s*"([^"]+)"/i)
  return m ? m[1].trim() : null
}

// ── 단어 단위 diff (LCS 기반) — 내가 말한 문장에서 틀린 단어 표시용 ──
function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '')
}

function diffWords(target: string, attempt: string): { word: string; ok: boolean }[] {
  const t = target.split(/\s+/).filter(Boolean).map(normalizeWord)
  const a = attempt.split(/\s+/).filter(Boolean)
  const aNorm = a.map(normalizeWord)
  const n = t.length
  const m = aNorm.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        t[i - 1] && t[i - 1] === aNorm[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const matched = new Array(m).fill(false)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (t[i - 1] && t[i - 1] === aNorm[j - 1]) {
      matched[j - 1] = true
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return a.map((word, idx) => ({ word, ok: matched[idx] }))
}

// ── 음성 합성 유틸 ──────────────────────────────────────────
type VoiceGender = 'male' | 'female'

// 브라우저 내장 TTS (폴백용) — 기계적인 발음이지만 항상 사용 가능
function speakBrowserTts(text: string, onEnd?: () => void, gender: VoiceGender = 'male') {
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = 'en-US'
  utt.rate = 0.92
  utt.pitch = gender === 'female' ? 1.25 : 1.0
  const voices = window.speechSynthesis.getVoices()
  const enVoices = voices.filter((v) => v.lang.startsWith('en'))
  const genderMatch = enVoices.find((v) =>
    gender === 'female'
      ? /female|woman|samantha|victoria|karen|zira|susan/i.test(v.name)
      : /male|man|daniel|david|alex|fred/i.test(v.name),
  )
  const enVoice =
    genderMatch ||
    enVoices.find((v) => v.localService) ||
    enVoices[0]
  if (enVoice) utt.voice = enVoice
  if (onEnd) {
    utt.onend = onEnd
    utt.onerror = onEnd
  }
  window.speechSynthesis.speak(utt)
}

// 모바일 브라우저는 사용자 제스처 없이 호출된 audio.play()를 자동재생 정책으로 막는 경우가 많다.
// <audio> 엘리먼트를 매번 새로 만들지 않고 하나만 재사용하면서, "시작하기" 같은 실제 탭 이벤트
// 안에서 한 번 재생/정지시켜 "unlock"해두면 이후 비동기 콜백 안에서의 재생도 허용된다.
let sharedTtsAudioEl: HTMLAudioElement | null = null

function getTtsAudioEl(): HTMLAudioElement {
  if (!sharedTtsAudioEl) {
    sharedTtsAudioEl = new Audio()
    sharedTtsAudioEl.preload = 'auto'
  }
  return sharedTtsAudioEl
}

// 사용자가 직접 누른 버튼의 onClick 안에서 동기적으로 호출해 모바일 자동재생 잠금을 해제한다.
function unlockTtsAudio() {
  const el = getTtsAudioEl()
  el.muted = true
  el.play()
    .then(() => {
      el.pause()
      el.muted = false
    })
    .catch(() => {
      el.muted = false
    })
}

function stopTts() {
  window.speechSynthesis.cancel()
  sharedTtsAudioEl?.pause()
}

// Gemini TTS(신경망 음성, 훨씬 자연스러운 발음) 우선 사용, 실패 시 브라우저 TTS로 폴백.
// 어떤 경로로도 onEnd가 호출되지 않는 상황(자동재생 차단 등)에 대비해 워치독 타이머로
// 항상 대화가 이어지도록 보장한다.
function ttsVoiceFor(gender: VoiceGender): string {
  // Gemini TTS 프리셋 음성 — Charon(남성), Kore(여성)
  return gender === 'female' ? 'Kore' : 'Charon'
}

async function speak(text: string, onEnd?: () => void, gender: VoiceGender = 'male') {
  stopTts()

  let finished = false
  let watchdog: ReturnType<typeof setTimeout>
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(watchdog)
    onEnd?.()
  }
  watchdog = setTimeout(finish, 15000)

  try {
    const res = await fetch('/api/gemini-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ttsVoiceFor(gender) }),
    })
    const data = await res.json()
    if (!res.ok || !data.audio) throw new Error(data.error || 'tts-failed')

    const el = getTtsAudioEl()
    el.muted = false
    el.src = `data:${data.mime};base64,${data.audio}`
    el.onended = finish
    el.onerror = () => speakBrowserTts(text, finish, gender)
    await el.play()

    // 모바일에서 play()가 resolve돼도 실제로는 소리 없이 멈춰있는 경우가 있다.
    // 재생 시작 후 currentTime이 전혀 움직이지 않으면 무음 재생으로 간주하고 폴백한다.
    setTimeout(() => {
      if (finished) return
      if (el.paused || el.currentTime === 0) {
        el.onended = null
        el.onerror = null
        el.pause()
        speakBrowserTts(text, finish, gender)
      }
    }, 2000)
  } catch {
    speakBrowserTts(text, finish, gender)
  }
}

// ── 타입 ────────────────────────────────────────────────────
type Message = { role: 'user' | 'model'; text: string; ko?: string; showKo?: boolean; auto?: boolean }
type SessionState = 'selecting' | 'idle' | 'ready' | 'listening' | 'thinking' | 'speaking'
type Category = (typeof PATTERN_CATEGORIES)[number] | StudyCategory

function isStudyCategory(cat: Category): cat is StudyCategory {
  return 'kind' in cat
}

type SpeakingPageProps = {
  studyItems?: StudyListItem[]
}

// ── 메인 컴포넌트 ───────────────────────────────────────────
export default function SpeakingPage({ studyItems = [] }: SpeakingPageProps) {
  const [sessionState, setSessionState] = useState<SessionState>('selecting')
  const [selectedCat, setSelectedCat] = useState<Category | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [transcript, setTranscript] = useState('')
  const [statusText, setStatusText] = useState('카테고리를 선택하세요')
  const [isMuted, setIsMuted] = useState(false)
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('free')
  const [shownKoPatterns, setShownKoPatterns] = useState<Set<string>>(new Set())
  const [fontScale, setFontScale] = useState<number>(() => {
    const saved = Number(localStorage.getItem('speaking-font-scale'))
    return saved && saved >= 0.8 && saved <= 1.8 ? saved : 1
  })
  const [lastCorrection, setLastCorrection] = useState<string | null>(null)
  const [lastUserAttempt, setLastUserAttempt] = useState('')
  const [shadowBoxVisible, setShadowBoxVisible] = useState(true)
  const [autoMode, setAutoMode] = useState(false)

  const recognitionRef = useRef<any>(null)
  const systemPromptRef = useRef<string>('')
  const historyRef = useRef<GeminiContent[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Message[]>([])
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startListeningRef = useRef<() => void>(() => {})
  const autoModeRef = useRef(false)
  const runAutoTurnRef = useRef<() => void>(() => {})

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    autoModeRef.current = autoMode
    // Auto 대화를 켰을 때 AI 응답을 기다리는 상태(ready)라면 바로 자동 대화를 이어간다.
    if (autoMode && sessionState === 'ready') {
      runAutoTurnRef.current()
    }
    // Auto 대화를 끄면 듣고 있던 인식은 정리하고 사용자가 직접 마이크를 누르도록 한다.
    if (!autoMode && sessionState === 'listening') {
      recognitionRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode])

  useEffect(() => {
    localStorage.setItem('speaking-font-scale', String(fontScale))
  }, [fontScale])

  const adjustFontScale = useCallback((delta: number) => {
    setFontScale((prev) => Math.min(1.8, Math.max(0.8, Math.round((prev + delta) * 10) / 10)))
  }, [])

  const studyCategories = useMemo(() => buildStudyCategories(studyItems), [studyItems])

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  // 메시지 자동 스크롤
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 음성 목록 로드 (iOS 대응)
  useEffect(() => {
    window.speechSynthesis.getVoices()
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()
  }, [])

  // AI가 말을 마친 뒤 다음 턴으로 넘어가는 공통 분기.
  // Auto 대화가 켜져 있으면 사용자 마이크 입력을 기다리지 않고 AI가 스스로 다음 발화를 만들어 이어간다.
  const proceedAfterAi = useCallback(() => {
    if (autoModeRef.current) {
      runAutoTurnRef.current()
    } else {
      startListeningRef.current()
    }
  }, [])

  // ── AI 응답 처리 ─────────────────────────────────────────
  const sendToAI = useCallback(
    async (userText: string) => {
      if (!systemPromptRef.current) return
      setSessionState('thinking')
      setStatusText('AI가 생각 중...')

      historyRef.current = [...historyRef.current, { role: 'user', parts: [{ text: userText }] }]

      try {
        const aiText = await callGeminiChat(systemPromptRef.current, historyRef.current)
        historyRef.current = [...historyRef.current, { role: 'model', parts: [{ text: aiText }] }]
        setMessages((prev) => [...prev, { role: 'model', text: aiText }])

        const correction = extractCorrection(aiText)
        if (correction) {
          setLastCorrection(correction)
          setLastUserAttempt('')
        }

        if (!isMuted) {
          setSessionState('speaking')
          setStatusText('AI 말하는 중...')
          speak(aiText, () => setTimeout(() => proceedAfterAi(), 400))
        } else {
          proceedAfterAi()
        }
      } catch {
        setStatusText('오류가 발생했습니다. 다시 시도하세요.')
        setSessionState('ready')
      }
    },
    [isMuted, proceedAfterAi],
  )

  // ── Auto 대화: 사용자 대신 AI가 학습자 역할의 다음 발화를 만들어 대화를 이어간다 ──
  const runAutoTurn = useCallback(async () => {
    if (!autoModeRef.current || !systemPromptRef.current) return
    setSessionState('thinking')
    setStatusText('Auto 대화 진행 중...')

    // 학습자 역할을 시뮬레이션하기 위해 user/model 역할을 뒤바꿔서 호출한다.
    // (Gemini는 항상 마지막이 'user'여야 다음 'model' 응답을 만들어주므로,
    //  지금까지의 AI 발화를 'user'로, 사용자 발화를 'model'로 바꿔 넣으면
    //  "다음 모델 응답"이 곧 학습자의 다음 발화가 된다.)
    const swappedHistory: GeminiContent[] = historyRef.current.map((h) => ({
      role: h.role === 'user' ? 'model' : 'user',
      parts: h.parts,
    }))
    const autoSystemPrompt =
      'You are simulating the LEARNER side of an English speaking-practice conversation. ' +
      'Based on the conversation so far, write ONLY the learner\'s next reply: 1-2 short, ' +
      'natural, casual English sentences that continue the conversation naturally. ' +
      'Output just the sentence(s) themselves — no labels, no quotes, no explanation.'

    try {
      const autoUserText = await callGeminiChat(autoSystemPrompt, swappedHistory)
      if (!autoModeRef.current) return // 생성 도중 Auto 대화가 꺼졌으면 중단
      setMessages((prev) => [...prev, { role: 'user', text: autoUserText, auto: true }])
      setLastUserAttempt(autoUserText)

      // 나를 대신하는 AI 대사도 들려준다. AI 캐릭터(남성 음성)와 구분되도록 여성 음성을 사용한다.
      if (!isMuted) {
        setSessionState('speaking')
        setStatusText('Auto 대화 읽는 중...')
        speak(autoUserText, () => sendToAI(autoUserText), 'female')
      } else {
        sendToAI(autoUserText)
      }
    } catch {
      setStatusText('Auto 대화 생성 중 오류가 발생했습니다.')
      setSessionState('ready')
    }
  }, [sendToAI, isMuted])

  useEffect(() => {
    runAutoTurnRef.current = runAutoTurn
  }, [runAutoTurn])

  // ── 카테고리 선택 (대화는 아직 시작하지 않음) ──────────────
  const selectCategory = useCallback((cat: Category) => {
    setSelectedCat(cat)
    setMessages([])
    setTranscript('')
    setShownKoPatterns(new Set())
    setLastCorrection(null)
    setLastUserAttempt('')
    setSessionState('idle')
    setStatusText('진행 방식을 고르고 시작하기 버튼을 눌러 대화를 시작하세요')
  }, [])

  const togglePatternKo = useCallback((en: string) => {
    setShownKoPatterns((prev) => {
      const next = new Set(prev)
      if (next.has(en)) next.delete(en)
      else next.add(en)
      return next
    })
  }, [])

  // ── 세션 시작 (AI가 먼저 말 걸기) ───────────────────────────
  const startSession = useCallback(
    async (cat: Category) => {
      setMessages([])
      setTranscript('')
      setSessionState('thinking')
      setStatusText('대화를 시작하는 중...')

      systemPromptRef.current = buildSystemPrompt(
        cat.id,
        cat.patterns.map((p) => p.en),
        practiceMode,
        isStudyCategory(cat) ? cat.kind : undefined,
      )
      historyRef.current = [
        {
          role: 'user',
          parts: [
            {
              text: 'Start the conversation now. Pick a casual daily-life topic and say something short to get me talking.',
            },
          ],
        },
      ]

      try {
        const aiText = await callGeminiChat(systemPromptRef.current, historyRef.current)
        historyRef.current = [...historyRef.current, { role: 'model', parts: [{ text: aiText }] }]
        setMessages([{ role: 'model', text: aiText }])
        setLastCorrection(null)
        setLastUserAttempt('')

        if (!isMuted) {
          setSessionState('speaking')
          setStatusText('AI 말하는 중...')
          speak(aiText, () => setTimeout(() => proceedAfterAi(), 400))
        } else {
          proceedAfterAi()
        }
      } catch (err) {
        setStatusText(`시작 오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}`)
        setSessionState('idle')
      }
    },
    [isMuted, practiceMode, proceedAfterAi],
  )

  // ── 음성 인식 시작 ────────────────────────────────────────
  // Android Chrome 등 일부 모바일 브라우저는 매 턴마다 새 SpeechRecognition 인스턴스를
  // 만들었다가 버리면 몇 차례 후부터 onstart는 정상 발생하지만 실제 인식 파이프라인이
  // 조용히 동작하지 않는 경우가 있다. 세션 동안 인스턴스를 하나만 만들어 재사용하고,
  // 매 턴마다 이벤트 핸들러만 새로 연결한다.
  const getRecognitionInstance = useCallback(() => {
    if (recognitionRef.current) return recognitionRef.current
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) return null
    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognitionRef.current = recognition
    return recognition
  }, [])

  const startListening = useCallback(() => {
    const recognition = getRecognitionInstance()
    if (!recognition) {
      alert('음성 인식은 Chrome 브라우저에서만 지원됩니다.')
      return
    }

    stopTts()
    recognition.onresult = null
    recognition.onend = null
    recognition.onerror = null
    recognition.onstart = null
    try {
      recognition.abort()
    } catch {
      // 이미 정지된 인스턴스 — 무시
    }

    let finalText = ''
    let settled = false // onend/onerror 중 하나라도 호출되면 true

    // 일부 Android Chrome 환경에서는 start()가 호출되어 onstart까지는 정상 발생하지만
    // 내부 인식 파이프라인이 멈춰버려 onresult/onend/onerror가 전혀 발생하지 않는
    // 경우가 있다. 이때는 stop()/abort()조차 반응이 없을 수 있으므로, 일정 시간 동안
    // settled 되지 않으면 인스턴스 자체를 버리고 다음 시도 때 새로 만들도록 강제 복구한다.
    let hardWatchdog: ReturnType<typeof setTimeout> | null = null
    const armHardWatchdog = () => {
      if (hardWatchdog) clearTimeout(hardWatchdog)
      hardWatchdog = setTimeout(() => {
        if (settled) return
        settled = true
        clearSilenceTimer()
        recognition.onresult = null
        recognition.onend = null
        recognition.onerror = null
        recognition.onstart = null
        try {
          recognition.abort()
        } catch {
          // 무시
        }
        recognitionRef.current = null // 손상된 인스턴스로 추정 — 다음 시도 때 새로 생성
        setTranscript('')
        setSessionState('ready')
        setStatusText('인식이 응답하지 않아요. 마이크 버튼을 눌러 다시 시도하세요.')
      }, 13000)
    }

    const resetSilenceTimer = () => {
      clearSilenceTimer()
      silenceTimerRef.current = setTimeout(() => recognition.stop(), 10000)
    }

    recognition.onstart = () => {
      setSessionState('listening')
      setStatusText('듣는 중... 말해보세요')
      setTranscript('')
      finalText = ''
      resetSilenceTimer()
      armHardWatchdog()
    }

    recognition.onresult = (event: any) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript
        if (event.results[i].isFinal) final += t
        else interim += t
      }
      if (final) finalText += final
      setTranscript(finalText || interim)
      setStatusText('듣는 중...')
      resetSilenceTimer()
      armHardWatchdog()
    }

    recognition.onend = () => {
      if (settled) return
      settled = true
      if (hardWatchdog) clearTimeout(hardWatchdog)
      clearSilenceTimer()
      const text = (finalText || transcript).trim()
      if (text) {
        setMessages((prev) => [...prev, { role: 'user', text }])
        setLastUserAttempt(text)
        setTranscript('')
        sendToAI(text)
      } else {
        setTranscript('')
        setSessionState('ready')
        setStatusText('말이 들리지 않았어요. 마이크 버튼을 눌러 다시 말해보세요.')
      }
    }

    recognition.onerror = (event: any) => {
      if (settled) return
      settled = true
      if (hardWatchdog) clearTimeout(hardWatchdog)
      clearSilenceTimer()
      // no-speech/aborted 외의 오류는 인식기가 손상되었을 가능성이 있으므로 다음번엔 새로 생성
      if (event?.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        recognitionRef.current = null
      }
      setSessionState('ready')
      setStatusText(
        event?.error === 'no-speech'
          ? '말이 들리지 않았어요. 마이크 버튼을 눌러 다시 말해보세요.'
          : '인식 오류. 마이크 버튼을 눌러 다시 시도하세요.',
      )
    }

    armHardWatchdog()

    try {
      recognition.start()
    } catch {
      // 직전 인식 인스턴스가 아직 정리되지 않은 경우 — 손상된 것으로 보고 새로 생성해 재시도
      recognitionRef.current = null
      setTimeout(() => startListeningRef.current(), 300)
    }
  }, [transcript, sendToAI, clearSilenceTimer, getRecognitionInstance])

  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  // ── 메시지 한글 번역 토글 ────────────────────────────────────
  const toggleTranslation = useCallback(async (index: number) => {
    const current = messagesRef.current[index]
    if (!current) return

    if (current.ko !== undefined) {
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, showKo: !m.showKo } : m)))
      return
    }

    try {
      const ko = await translateToKorean(current.text)
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, ko, showKo: true } : m)))
    } catch {
      // 번역 실패 시 그대로 유지
    }
  }, [])

  // ── 세션 종료 ─────────────────────────────────────────────
  const endSession = () => {
    stopTts()
    clearSilenceTimer()
    if (recognitionRef.current) recognitionRef.current.onend = null
    recognitionRef.current?.stop()
    systemPromptRef.current = ''
    historyRef.current = []
    setSessionState('selecting')
    setSelectedCat(null)
    setMessages([])
    setTranscript('')
    setLastCorrection(null)
    setLastUserAttempt('')
    setAutoMode(false)
    setStatusText('카테고리를 선택하세요')
  }

  // ── 카테고리 선택 화면 ────────────────────────────────────
  if (sessionState === 'selecting') {
    return (
      <section className="speaking-page">
        <div className="speaking-header">
          <h2>🎙️ Speaking Practice</h2>
          <p>연습할 패턴 카테고리를 선택하세요. AI가 먼저 말을 걸고, 마이크 버튼을 눌러 대답하세요.</p>
        </div>
        {statusText !== '카테고리를 선택하세요' && (
          <p className={statusText.includes('오류') ? 'speaking-error' : 'speaking-tip'}>
            {statusText}
          </p>
        )}
        <div className="speaking-cat-grid">
          {PATTERN_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              className="speaking-cat-btn"
              style={{ borderColor: cat.color, color: cat.color }}
              onClick={() => selectCategory(cat)}
            >
              <span className="cat-id">{cat.id}</span>
              <span className="cat-label">{cat.label.replace(`${cat.id}. `, '')}</span>
              <span className="cat-count">{cat.patterns.length}개 패턴</span>
            </button>
          ))}
        </div>

        <h3 className="speaking-section-title">📒 내 단어장으로 연습하기</h3>
        <div className="speaking-cat-grid speaking-cat-grid-study">
          {studyCategories.map((cat) => (
            <button
              key={cat.id}
              className="speaking-cat-btn speaking-cat-btn-study"
              style={{ borderColor: cat.color, color: cat.color }}
              onClick={() => cat.patterns.length > 0 && selectCategory(cat)}
              disabled={cat.patterns.length === 0}
            >
              <span className="cat-id">{cat.id}</span>
              <span className="cat-label">{cat.label.replace(`${cat.id}. `, '')}</span>
              <span className="cat-count">
                {cat.patterns.length > 0
                  ? `전체 ${cat.totalCount}개 중 빈도 높은 ${cat.patterns.length}개`
                  : '등록된 항목 없음'}
              </span>
            </button>
          ))}
        </div>

        <p className="speaking-tip">
          💡 운전·운동 중엔 🔊 음성 모드로, 조용한 환경에선 🔇 음소거 후 텍스트로 연습하세요.
        </p>
      </section>
    )
  }

  // ── 대화 화면 ─────────────────────────────────────────────
  return (
    <section
      className="speaking-page speaking-active"
      style={{ '--speaking-font-scale': fontScale } as React.CSSProperties}
    >
      {/* 상단 헤더 */}
      <div className="speaking-session-header">
        <button className="speaking-back-btn" onClick={endSession}>
          ← 카테고리 변경
        </button>
        <div className="speaking-cat-badge" style={{ background: selectedCat?.color }}>
          {selectedCat?.label}
        </div>
        <div className="speaking-font-ctrl">
          <button
            type="button"
            onClick={() => adjustFontScale(-0.1)}
            title="글자 작게"
            disabled={fontScale <= 0.8}
          >
            A-
          </button>
          <button
            type="button"
            onClick={() => adjustFontScale(0.1)}
            title="글자 크게"
            disabled={fontScale >= 1.8}
          >
            A+
          </button>
        </div>
        <button
          className={`speaking-mute-btn ${isMuted ? 'muted' : ''}`}
          onClick={() => {
            setIsMuted((v) => !v)
            stopTts()
          }}
          title={isMuted ? '음성 켜기' : '음성 끄기'}
        >
          {isMuted ? '🔇' : '🔊'}
        </button>
      </div>

      {/* 패턴 목록 (접기/펼치기) */}
      <details className="speaking-patterns-detail">
        <summary>연습 패턴 보기 ({selectedCat?.patterns.length}개)</summary>
        <div className="speaking-patterns-list">
          {selectedCat?.patterns.map((p) => (
            <button
              key={p.en}
              type="button"
              className="speaking-pattern-chip"
              onClick={() => togglePatternKo(p.en)}
              title="클릭하면 한글/영어 전환"
            >
              {shownKoPatterns.has(p.en) ? p.ko : p.en}
            </button>
          ))}
        </div>
      </details>

      {/* 쉐도잉 비교 박스 (교정 모드) */}
      {practiceMode === 'correct' && lastCorrection && (
        <div className="speaking-shadow-box">
          {shadowBoxVisible ? (
            <>
              <button
                type="button"
                className="speaking-shadow-toggle"
                onClick={() => setShadowBoxVisible(false)}
              >
                숨기기 ▲
              </button>
              <div className="speaking-shadow-row">
                <span className="speaking-shadow-label">✅ AI 추천 문장</span>
                <p className="speaking-shadow-target">{lastCorrection}</p>
              </div>
              <div className="speaking-shadow-row">
                <span className="speaking-shadow-label">🎤 내가 말한 문장</span>
                <p className="speaking-shadow-attempt">
                  {lastUserAttempt ? (
                    diffWords(lastCorrection, lastUserAttempt).map((w, i) => (
                      <span key={i} className={w.ok ? '' : 'speaking-shadow-wrong'}>
                        {w.word}{' '}
                      </span>
                    ))
                  ) : (
                    <span className="speaking-shadow-waiting">따라 말해보세요...</span>
                  )}
                </p>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="speaking-shadow-toggle"
              onClick={() => setShadowBoxVisible(true)}
            >
              쉐도잉 비교 보기 ▼
            </button>
          )}
        </div>
      )}

      {/* 메시지 영역 */}
      <div className="speaking-messages">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`speaking-msg speaking-msg-${msg.role} ${msg.auto ? 'speaking-msg-auto' : ''}`}
            onClick={() => toggleTranslation(i)}
            title="클릭하면 한글 번역 보기"
          >
            <span className="speaking-msg-role">
              {msg.role === 'model' ? 'AI' : msg.auto ? 'Me (Auto)' : 'Me'}
            </span>
            <p>{msg.showKo && msg.ko ? msg.ko : msg.text}</p>
          </div>
        ))}
        {transcript && (
          <div className="speaking-msg speaking-msg-interim">
            <span className="speaking-msg-role">Me</span>
            <p>{transcript}</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 상태 표시 */}
      <div className={`speaking-status speaking-status-${sessionState}`}>
        {sessionState === 'listening' && <span className="speaking-pulse" />}
        {statusText}
      </div>

      {/* 컨트롤 버튼 */}
      <div className="speaking-controls">
        {sessionState === 'idle' ? (
          <>
            <div className="speaking-mode-select">
              <button
                type="button"
                className={`speaking-mode-btn ${practiceMode === 'free' ? 'active' : ''}`}
                onClick={() => setPracticeMode('free')}
              >
                💬 자유롭게 대화하기
                <small>오류가 있어도 대화를 계속 이어가요</small>
              </button>
              <button
                type="button"
                className={`speaking-mode-btn ${practiceMode === 'correct' ? 'active' : ''}`}
                onClick={() => setPracticeMode('correct')}
              >
                ✏️ 오류 교정 + 쉐도잉
                <small>틀린 부분을 고쳐주고 따라 말해보게 해요</small>
              </button>
            </div>
            <button
              className="speaking-mic-btn speaking-start-btn"
              onClick={() => {
                unlockTtsAudio()
                if (selectedCat) startSession(selectedCat)
              }}
            >
              🚀 시작하기
            </button>
          </>
        ) : (
          <button
            className={`speaking-mic-btn ${sessionState === 'listening' ? 'active' : ''}`}
            disabled={autoMode || sessionState === 'thinking' || sessionState === 'speaking'}
            onClick={
              sessionState === 'listening'
                ? () => recognitionRef.current?.stop()
                : startListening
            }
          >
            {autoMode
              ? '🤖 Auto 대화 중...'
              : sessionState === 'listening'
                ? '🔴 듣는 중...'
                : '🎤 말하기'}
          </button>
        )}
        <div className="speaking-quick-btns">
          <button disabled={sessionState === 'idle'} onClick={() => sendToAI('feedback')}>
            📊 피드백
          </button>
          <button disabled={sessionState === 'idle'} onClick={() => sendToAI('next')}>
            ➡️ 다음 주제
          </button>
          <button onClick={endSession}>🔄 처음으로</button>
          <button
            className={`speaking-auto-btn ${autoMode ? 'active' : ''}`}
            onClick={() => setAutoMode((v) => !v)}
            title={autoMode ? 'Auto 대화 끄기 (다시 내가 말하기)' : 'Auto 대화 켜기 (AI가 내 대신 대화 이어가기)'}
          >
            🤖 Auto 대화 {autoMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
    </section>
  )
}
