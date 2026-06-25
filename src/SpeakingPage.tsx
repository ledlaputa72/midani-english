import { useState, useRef, useEffect, useCallback } from 'react'

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
      'You know', 'I mean', 'I think', 'I know', "That's right",
      'Kind of / Sort of', 'I see', 'Exactly', 'That makes sense', 'Fair enough',
    ],
  },
  {
    id: 'B',
    label: 'B. 의견·생각',
    color: '#312e81',
    patterns: [
      'I think that~', 'I feel like~', 'I guess~', "I'm not sure~",
      'To be honest~', 'Actually~', 'Honestly~', 'The thing is~',
      'I was thinking~', 'It seems like~',
    ],
  },
  {
    id: 'C',
    label: 'C. 질문 패턴',
    color: '#92400e',
    patterns: [
      'Do you~?', 'What do you~?', 'How do you~?', 'Did you~?',
      'Are you~?', 'Can you~?', 'Could you~?', 'Have you ever~?',
      'Would you~?', "Why don't we~?", "What's going on?",
      'What happened?', 'What do you mean?', 'How was~?', 'What are you~?',
    ],
  },
  {
    id: 'D',
    label: 'D. 부정·불확실',
    color: '#9f1239',
    patterns: [
      "I don't~", "I don't know", "I can't~", "I don't think~",
      "That's not~", "It's not like~", "I'm not really~", 'Not really',
      "It doesn't matter", 'I have no idea',
    ],
  },
  {
    id: 'E',
    label: 'E. 제안·요청',
    color: '#155e75',
    patterns: [
      "Let's~", 'I want to~', 'I need to~', 'I was wondering if~',
      'Would you mind~?', 'Do you want to~?', 'How about~?',
      'What if~?', 'You should~', "Why don't you~?",
    ],
  },
  {
    id: 'F',
    label: 'F. 시간·상황',
    color: '#5b21b6',
    patterns: [
      "I'm going to~", 'I was~ing', "I've been~ing", 'I used to~',
      "I'm about to~", "I'll~", 'At the end of the day',
      'By the way', 'Right now', 'All the time',
    ],
  },
  {
    id: 'G',
    label: 'G. 감정·강조',
    color: '#9a3412',
    patterns: [
      'Oh my God', "That's so~", "I'm so~", 'No way!',
      'Are you serious?', "It's such a~", "That's crazy", "I'm sorry~",
      "I can't believe~", 'What a~',
    ],
  },
  {
    id: 'H',
    label: 'H. 대화 연결',
    color: '#1e293b',
    patterns: [
      'So~', 'And then~', 'I mean~ (재확인)', 'Well~', 'Anyway~',
      'Speaking of~', 'On top of that~', 'Either way~',
      'I mean, honestly~', 'Let me know',
    ],
  },
  {
    id: 'I',
    label: 'I. 구어체',
    color: '#166534',
    patterns: [
      'I gotta~', 'Wanna~', 'Gonna~', 'I know, right?',
      "That's what I'm saying", "What's up?", 'Hang on~', 'Come on~',
      'Never mind', "Don't worry about it", "It's up to you",
      'I totally~', 'You know what?', 'Go ahead', 'My bad',
    ],
  },
]

// ── 시스템 프롬프트 생성 ─────────────────────────────────────
function buildSystemPrompt(categoryId: string, patterns: string[]): string {
  return `You are my American friend having a casual, natural conversation with me in English.

Your goal is to naturally use and encourage these specific English patterns in our conversation:
${patterns.map((p, i) => `${i + 1}. "${p}"`).join('\n')}

Rules:
- Keep each response SHORT — 2 to 3 sentences max. I need to respond quickly.
- Speak like a real friend, not a teacher. Natural and casual.
- Naturally weave the target patterns into your own sentences when appropriate.
- When I use a pattern correctly, briefly acknowledge it or just continue naturally.
- Do NOT interrupt or correct mid-conversation. Wait until I say "feedback" to give corrections.
- If I say "feedback", summarize: which patterns I used, which I missed, and one tip.
- If I say "next" or "다음", switch to a new conversation topic.
- If I say "stop" or "그만", end the session warmly.
- Start the conversation naturally — introduce a topic and invite me to respond.
- Category focus: ${categoryId}`
}

// ── 음성 합성 유틸 ──────────────────────────────────────────
function speak(text: string, onEnd?: () => void) {
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = 'en-US'
  utt.rate = 0.92
  utt.pitch = 1.0
  const voices = window.speechSynthesis.getVoices()
  const enVoice =
    voices.find((v) => v.lang.startsWith('en') && v.localService) ||
    voices.find((v) => v.lang.startsWith('en'))
  if (enVoice) utt.voice = enVoice
  if (onEnd) utt.onend = onEnd
  window.speechSynthesis.speak(utt)
}

// ── 타입 ────────────────────────────────────────────────────
type Message = { role: 'user' | 'model'; text: string }
type SessionState = 'selecting' | 'idle' | 'ready' | 'listening' | 'thinking' | 'speaking'
type Category = (typeof PATTERN_CATEGORIES)[0]

// ── 메인 컴포넌트 ───────────────────────────────────────────
export default function SpeakingPage() {
  const [sessionState, setSessionState] = useState<SessionState>('selecting')
  const [selectedCat, setSelectedCat] = useState<Category | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [transcript, setTranscript] = useState('')
  const [statusText, setStatusText] = useState('카테고리를 선택하세요')
  const [isMuted, setIsMuted] = useState(false)

  const recognitionRef = useRef<any>(null)
  const systemPromptRef = useRef<string>('')
  const historyRef = useRef<GeminiContent[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startListeningRef = useRef<() => void>(() => {})

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

        if (!isMuted) {
          setSessionState('speaking')
          setStatusText('AI 말하는 중...')
          speak(aiText, () => setTimeout(() => startListeningRef.current(), 400))
        } else {
          startListeningRef.current()
        }
      } catch {
        setStatusText('오류가 발생했습니다. 다시 시도하세요.')
        setSessionState('ready')
      }
    },
    [isMuted],
  )

  // ── 카테고리 선택 (대화는 아직 시작하지 않음) ──────────────
  const selectCategory = useCallback((cat: Category) => {
    setSelectedCat(cat)
    setMessages([])
    setTranscript('')
    setSessionState('idle')
    setStatusText('시작하기 버튼을 눌러 대화를 시작하세요')
  }, [])

  // ── 세션 시작 (AI가 먼저 말 걸기) ───────────────────────────
  const startSession = useCallback(
    async (cat: Category) => {
      setMessages([])
      setTranscript('')
      setSessionState('thinking')
      setStatusText('대화를 시작하는 중...')

      systemPromptRef.current = buildSystemPrompt(cat.id, cat.patterns)
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

        if (!isMuted) {
          setSessionState('speaking')
          setStatusText('AI 말하는 중...')
          speak(aiText, () => setTimeout(() => startListeningRef.current(), 400))
        } else {
          startListeningRef.current()
        }
      } catch (err) {
        setStatusText(`시작 오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}`)
        setSessionState('idle')
      }
    },
    [isMuted],
  )

  // ── 음성 인식 시작 ────────────────────────────────────────
  const startListening = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('음성 인식은 Chrome 브라우저에서만 지원됩니다.')
      return
    }

    window.speechSynthesis.cancel()
    if (recognitionRef.current) {
      recognitionRef.current.onend = null
      recognitionRef.current.onerror = null
      try {
        recognitionRef.current.abort()
      } catch {
        // 이미 정지된 인스턴스 — 무시
      }
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognitionRef.current = recognition

    let finalText = ''

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
    }

    recognition.onend = () => {
      clearSilenceTimer()
      const text = (finalText || transcript).trim()
      if (text) {
        setMessages((prev) => [...prev, { role: 'user', text }])
        setTranscript('')
        sendToAI(text)
      } else {
        setTranscript('')
        setSessionState('ready')
        setStatusText('말이 들리지 않았어요. 마이크 버튼을 눌러 다시 말해보세요.')
      }
    }

    recognition.onerror = (event: any) => {
      clearSilenceTimer()
      setSessionState('ready')
      setStatusText(
        event?.error === 'no-speech'
          ? '말이 들리지 않았어요. 마이크 버튼을 눌러 다시 말해보세요.'
          : '인식 오류. 마이크 버튼을 눌러 다시 시도하세요.',
      )
    }

    try {
      recognition.start()
    } catch {
      // 직전 인식 인스턴스가 아직 정리되지 않은 경우 — 잠시 후 재시도
      setTimeout(() => startListeningRef.current(), 300)
    }
  }, [transcript, sendToAI, clearSilenceTimer])

  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  // ── 세션 종료 ─────────────────────────────────────────────
  const endSession = () => {
    window.speechSynthesis.cancel()
    clearSilenceTimer()
    if (recognitionRef.current) recognitionRef.current.onend = null
    recognitionRef.current?.stop()
    systemPromptRef.current = ''
    historyRef.current = []
    setSessionState('selecting')
    setSelectedCat(null)
    setMessages([])
    setTranscript('')
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
        <p className="speaking-tip">
          💡 운전·운동 중엔 🔊 음성 모드로, 조용한 환경에선 🔇 음소거 후 텍스트로 연습하세요.
        </p>
      </section>
    )
  }

  // ── 대화 화면 ─────────────────────────────────────────────
  return (
    <section className="speaking-page speaking-active">
      {/* 상단 헤더 */}
      <div className="speaking-session-header">
        <button className="speaking-back-btn" onClick={endSession}>
          ← 카테고리 변경
        </button>
        <div className="speaking-cat-badge" style={{ background: selectedCat?.color }}>
          {selectedCat?.label}
        </div>
        <button
          className={`speaking-mute-btn ${isMuted ? 'muted' : ''}`}
          onClick={() => {
            setIsMuted((v) => !v)
            window.speechSynthesis.cancel()
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
            <span key={p} className="speaking-pattern-chip">
              {p}
            </span>
          ))}
        </div>
      </details>

      {/* 메시지 영역 */}
      <div className="speaking-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`speaking-msg speaking-msg-${msg.role}`}>
            <span className="speaking-msg-role">{msg.role === 'model' ? 'AI' : 'Me'}</span>
            <p>{msg.text}</p>
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
          <button
            className="speaking-mic-btn speaking-start-btn"
            onClick={() => selectedCat && startSession(selectedCat)}
          >
            🚀 시작하기
          </button>
        ) : (
          <button
            className={`speaking-mic-btn ${sessionState === 'listening' ? 'active' : ''}`}
            disabled={sessionState === 'thinking' || sessionState === 'speaking'}
            onClick={
              sessionState === 'listening'
                ? () => recognitionRef.current?.stop()
                : startListening
            }
          >
            {sessionState === 'listening' ? '🔴 듣는 중...' : '🎤 말하기'}
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
        </div>
      </div>
    </section>
  )
}
