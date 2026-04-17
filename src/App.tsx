import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DragEvent as ReactDragEvent, FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { User } from 'firebase/auth'
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { auth, db, firebaseReady } from './firebase'
import './App.css'

type Status = 'new' | 'learning' | 'mastered'
type ItemType = 'vocabulary' | 'expression' | 'idiom'
type AiProvider = 'default' | 'gemini'
type Page = 'dashboard' | 'list' | 'board' | 'cards' | 'calendar'
type InputTab = 'text' | 'ocr'
type ListSort = 'latest' | 'oldest' | 'phrase'
type CardRating = 'again' | 'good' | 'easy' | 'skip'
type CardEnterDir = 'next' | 'prev'

type StudyItem = {
  id: string
  phrase: string
  translation: string
  example: string
  show: string
  episode: string
  tags: string[]
  difficulty: 1 | 2 | 3
  notes: string
  deck: string
  status: Status
  reviewCount: number
  createdAt: string
  lastReviewedAt?: string
  scheduledDate?: string
  profileId?: string | null
  itemType?: ItemType
}

type CardInfoProfile = {
  id: string
  name: string
  show: string
  episode: string
  tags: string[]
  difficulty: 1 | 2 | 3
  notes: string
  deck: string
  createdAt: string
  updatedAt: string
}

type AppSettings = {
  defaultAiProvider: AiProvider
}

type FormState = {
  phrase: string
  translation: string
  example: string
  show: string
  episode: string
  tags: string
  difficulty: 1 | 2 | 3
  notes: string
  deck: string
  profileId: string
  itemType: ItemType
}

const STORAGE_KEY = 'midani.study.items.v2'
const FIREBASE_DOC_KEY = 'studyItems'
const GEMINI_API_KEY =
  (
    import.meta as ImportMeta & {
      env?: Record<string, string | undefined>
    }
  ).env?.VITE_GEMINI_API_KEY?.trim() || ''

/** 플래시카드 자동 넘김 간격 (롤링 배너, ms) */
const CARD_AUTO_ADVANCE_MS = 8000
const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultAiProvider: 'default',
}

const STATUS_LABEL: Record<Status, string> = {
  new: '새 단어',
  learning: '학습 중',
  mastered: '완료',
}

const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  vocabulary: 'Vocabulary',
  expression: 'Expression',
  idiom: 'Idiom',
}

const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  default: '기본 엔진 (사전+번역)',
  gemini: 'Gemini',
}

const NAV_ITEMS: Array<{ id: Page; label: string }> = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'list', label: '리스트' },
  { id: 'board', label: '보드' },
  { id: 'cards', label: '플래시카드' },
  { id: 'calendar', label: '캘린더' },
]

const EMPTY_FORM: FormState = {
  phrase: '',
  translation: '',
  example: '',
  show: '',
  episode: '',
  tags: '',
  difficulty: 2,
  notes: '',
  deck: '기본 덱',
  profileId: '',
  itemType: 'vocabulary',
}

const SAMPLE_ITEMS: StudyItem[] = [
  {
    id: crypto.randomUUID(),
    phrase: "I'll take a rain check",
    translation: '다음 기회에 할게요',
    example: "I can't join you tonight, but I'll take a rain check.",
    show: 'Friends',
    episode: 'S06E03',
    tags: ['idiom'],
    difficulty: 2,
    notes: '연기하다, 다음에 하겠다는 의미',
    deck: '일상 회화',
    status: 'new',
    reviewCount: 0,
    createdAt: '2026-04-11',
  },
  {
    id: crypto.randomUUID(),
    phrase: 'That ship has sailed',
    translation: '그 기회는 이미 지나갔어',
    example: 'I wanted to apologize, but that ship has sailed.',
    show: 'Friends',
    episode: 'S06E03',
    tags: ['idiom'],
    difficulty: 2,
    notes: '기회 상실을 표현',
    deck: '일상 회화',
    status: 'learning',
    reviewCount: 1,
    createdAt: '2026-04-12',
  },
  {
    id: crypto.randomUUID(),
    phrase: 'Pull yourself together',
    translation: '정신 차려',
    example: 'You need to pull yourself together right now.',
    show: 'The Office',
    episode: 'S03E12',
    tags: ['phrasal-verb', 'emotion'],
    difficulty: 3,
    notes: '감정을 수습할 때 자주 쓰는 표현',
    deck: '감정 표현',
    status: 'mastered',
    reviewCount: 4,
    createdAt: '2026-04-10',
    lastReviewedAt: '2026-04-13',
  },
]

function normalizeItems(source: StudyItem[] | unknown): StudyItem[] {
  if (!Array.isArray(source)) return []
  return source.map((item) => ({
    ...(item as StudyItem),
    show: (item as StudyItem).show ?? '',
    episode: (item as StudyItem).episode ?? '',
    notes: (item as StudyItem).notes ?? '',
    tags: Array.isArray((item as StudyItem).tags)
      ? (item as StudyItem).tags
      : String((item as StudyItem).tags ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
    deck: (item as StudyItem).deck?.trim() || '기본 덱',
    difficulty:
      (item as StudyItem).difficulty === 1 ||
      (item as StudyItem).difficulty === 2 ||
      (item as StudyItem).difficulty === 3
        ? (item as StudyItem).difficulty
        : 2,
    profileId: typeof (item as StudyItem).profileId === 'string' ? (item as StudyItem).profileId : null,
    itemType: (() => {
      const rawType = (item as StudyItem).itemType
      if (rawType === 'vocabulary' || rawType === 'expression' || rawType === 'idiom') return rawType
      if (rawType === 'word') return 'vocabulary'
      if (rawType === 'phrase') return 'expression'
      return inferItemType((item as StudyItem).phrase ?? '')
    })(),
  }))
}

function normalizeProfiles(source: CardInfoProfile[] | unknown): CardInfoProfile[] {
  if (!Array.isArray(source)) return []
  return source
    .map((item) => {
      const raw = item as Partial<CardInfoProfile>
      const now = new Date().toISOString().slice(0, 10)
      return {
        id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
        name: (raw.name ?? '').trim(),
        show: (raw.show ?? '').trim(),
        episode: (raw.episode ?? '').trim(),
        tags: Array.isArray(raw.tags)
          ? raw.tags.map((tag) => String(tag).trim()).filter(Boolean)
          : String(raw.tags ?? '')
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
        difficulty: raw.difficulty === 1 || raw.difficulty === 2 || raw.difficulty === 3 ? raw.difficulty : 2,
        notes: (raw.notes ?? '').trim(),
        deck: (raw.deck ?? '').trim() || '기본 덱',
        createdAt: (raw.createdAt ?? '').trim() || now,
        updatedAt: (raw.updatedAt ?? '').trim() || now,
      }
    })
    .filter((p) => p.name.length > 0)
}

function normalizeAppSettings(source: unknown): AppSettings {
  const raw = (source ?? {}) as Partial<AppSettings>
  return {
    defaultAiProvider: raw.defaultAiProvider === 'gemini' ? 'gemini' : 'default',
  }
}

function loadLocalData(): { items: StudyItem[]; profiles: CardInfoProfile[]; settings: AppSettings } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { items: [], profiles: [], settings: DEFAULT_APP_SETTINGS }
    const parsed = JSON.parse(raw) as { items?: unknown; profiles?: unknown } | unknown[]
    if (Array.isArray(parsed)) {
      return { items: normalizeItems(parsed), profiles: [], settings: DEFAULT_APP_SETTINGS }
    }
    return {
      items: normalizeItems(parsed?.items),
      profiles: normalizeProfiles(parsed?.profiles),
      settings: normalizeAppSettings((parsed as { settings?: unknown })?.settings),
    }
  } catch {
    return { items: [], profiles: [], settings: DEFAULT_APP_SETTINGS }
  }
}

function dateText(value?: string): string {
  if (!value) return '없음'
  return value
}

function toDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function monthTitle(date: Date): string {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`
}

function cyclicIndex(index: number, total: number): number {
  if (total === 0) return 0
  return ((index % total) + total) % total
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function weekRangeTitle(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  return `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`
}

function toFormState(item: StudyItem): FormState {
  return {
    phrase: item.phrase,
    translation: item.translation,
    example: item.example,
    show: item.show,
    episode: item.episode,
    tags: item.tags.join(', '),
    difficulty: item.difficulty,
    notes: item.notes,
    deck: item.deck || '기본 덱',
    profileId: item.profileId ?? '',
    itemType: item.itemType ?? inferItemType(item.phrase),
  }
}

function inferItemType(phrase: string): ItemType {
  return /\s/.test(phrase.trim()) ? 'expression' : 'vocabulary'
}

function splitTranslationParts(text: string): { primary: string; secondary: string[] } {
  const raw = text.trim()
  if (!raw) return { primary: '', secondary: [] }

  const marker = '대체 표현:'
  const markerIdx = raw.indexOf(marker)
  if (markerIdx === -1) return { primary: raw, secondary: [] }

  const primary = raw.slice(0, markerIdx).trim()
  const remainder = raw.slice(markerIdx + marker.length).trim()
  const secondary = remainder
    .split('\n')
    .map((line) => line.replace(/^-+\s*/, '').trim())
    .filter(Boolean)

  return { primary, secondary }
}

/** Split display phrase into tokens (whitespace; strip edge punctuation). */
function splitPhraseWords(phrase: string): string[] {
  return phrase
    .trim()
    .split(/\s+/)
    .map((part) =>
      part.replace(/^[\s"'“”‘’.,!?;:()[\]{}—–-]+|["'“”‘’.,!?;:()[\]{}—–-]+$/g, ''),
    )
    .filter((w) => w.length > 0)
}

/** 번역 API(MyMemory 등)가 넣는 정렬용 마크업(<g id="n">…</g>) 및 기타 태그 제거 */
function sanitizeTranslationApiText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function toSentenceCase(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

function deterministicPick<T>(items: T[], seed: string): T {
  if (items.length === 0) {
    throw new Error('deterministicPick requires at least one item')
  }
  let acc = 0
  for (const ch of seed) acc = (acc * 31 + ch.charCodeAt(0)) % 2147483647
  return items[acc % items.length]
}

function normalizeForContains(text: string): string {
  return text.toLowerCase().replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
}

function includesPhrase(haystack: string, phrase: string): boolean {
  const h = normalizeForContains(haystack)
  const p = normalizeForContains(phrase)
  if (!h || !p) return false
  return h.includes(p)
}

function buildPhraseFallbackExample(phrase: string): string {
  const cleanPhrase = phrase.trim()
  const templates = [
    `A: The points have been allocated.\nB: ${cleanPhrase}`,
    `A: I think this plan is fair.\nB: ${cleanPhrase}. Let's double-check the details.`,
    `A: Why are you upset right now?\nB: ${cleanPhrase}. That's how it felt to me.`,
    `A: Did the team agree on the decision?\nB: Yes, and ${cleanPhrase}.`,
  ]
  return deterministicPick(templates, cleanPhrase)
}

function buildWordFallbackExample(word: string, definitionHint?: string): string {
  const cleanWord = word.trim()
  const cleanDef = (definitionHint ?? '').trim()
  const hintClause = cleanDef ? ` It refers to "${cleanDef}".` : ''
  const templates = [
    `She used "${cleanWord}" in class to explain her point clearly.${hintClause}`,
    `I heard "${cleanWord}" in a podcast and decided to practice it today.${hintClause}`,
    `The article used "${cleanWord}" to describe the main issue.${hintClause}`,
    `Try saying "${cleanWord}" in your own sentence to remember it better.${hintClause}`,
  ]
  return deterministicPick(templates, cleanWord)
}

function isLikelyAutoGeneratedExample(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    normalized.startsWith('a: ') ||
    normalized.startsWith('people often say "') ||
    normalized.includes('you can hear "') ||
    normalized.includes('i heard "') ||
    normalized.includes('try saying "')
  )
}

function isLikelyKoreanText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const hangulChars = (trimmed.match(/[가-힣]/g) ?? []).length
  const latinChars = (trimmed.match(/[A-Za-z]/g) ?? []).length
  return hangulChars >= 2 && hangulChars >= latinChars
}

function normalizeKoreanMeaningLine(text: string): string {
  return sanitizeTranslationApiText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && isLikelyKoreanText(line))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function pickWordMeaningCandidate(candidates: string[]): string {
  if (candidates.length === 0) return ''
  const scored = candidates
    .map((line) => {
      const clean = line.trim()
      let score = 0
      if (clean.length <= 20) score += 6
      else if (clean.length <= 32) score += 3
      if (!/[.!?]/.test(clean)) score += 3
      if (!/[-→]/.test(clean)) score += 2
      if (!/\s{2,}/.test(clean)) score += 1
      return { clean, score }
    })
    .sort((a, b) => b.score - a.score || a.clean.length - b.clean.length)
  return scored[0]?.clean ?? candidates[0]
}

type GeminiAutofillResult = {
  meaningKo: string
  altMeaningsKo: string[]
  exampleEn: string
  exampleKo?: string
  definitionHint?: string
  itemType?: ItemType
}

const PHRASE_USAGE_OVERRIDES: Record<
  string,
  { meaningKo: string; altMeaningsKo?: string[]; exampleEn: string; exampleKo: string; itemType?: ItemType }
> = {
  'cut it out': {
    meaningKo: '그만해.',
    altMeaningsKo: ['집어치워.', '그만 좀 해.'],
    exampleEn: 'A: Why are you making fun of him?\nB: Okay, okay. Cut it out. I got it.',
    exampleKo: 'A: 왜 그를 놀리는 거야?\nB: 알았어, 알았어. 그만할게.',
    itemType: 'idiom',
  },
}

function extractFirstJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1).trim()
}

async function translateEnglishToKorean(text: string): Promise<string> {
  const clean = text.trim()
  if (!clean) return ''
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|ko`,
    )
    if (!res.ok) return ''
    const data = (await res.json()) as { responseData?: { translatedText?: string } }
    return normalizeKoreanMeaningLine(data.responseData?.translatedText ?? '')
  } catch {
    return ''
  }
}

async function generateMeaningAndExampleWithGemini(
  phrase: string,
  itemType: ItemType,
): Promise<{ result: GeminiAutofillResult | null; error?: string }> {
  if (!GEMINI_API_KEY) return { result: null, error: 'missing-key' }
  const typeLabel =
    itemType === 'vocabulary' ? 'vocabulary(word)' : itemType === 'idiom' ? 'idiom' : 'expression'
  const prompt = [
    'You are an English learning assistant for Korean learners.',
    `Target text: "${phrase}"`,
    `Item type: ${typeLabel}`,
    'Return ONLY JSON with keys:',
    '{ "meaningKo": string, "altMeaningsKo": string[], "definitionHint": string, "exampleEn": string, "exampleKo": string, "itemType": "vocabulary"|"expression"|"idiom" }',
    'Rules:',
    '- For expression/idiom, prioritize natural usage meaning (NOT literal translation).',
    '- exampleEn must include the exact target text naturally.',
    '- For expression/idiom, make exampleEn a 2-line dialogue using "A:" and "B:".',
    '- meaningKo should be concise and practical for learners.',
  ].join('\n')

  const modelsToTry = [
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
  ]
  const apiBase = `https://generativelanguage.googleapis.com/v1beta/models`
  const apiKey = encodeURIComponent(GEMINI_API_KEY)
  let lastError = ''
  for (const model of modelsToTry) {
    try {
    const res = await fetch(
      `${apiBase}/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      },
    )
    if (!res.ok) {
      lastError = `http-${res.status}(${model})`
      continue
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const rawText = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('\n') ?? ''
    const jsonText = extractFirstJsonObject(rawText)
    if (!jsonText) {
      lastError = 'invalid-json'
      continue
    }
    const parsed = JSON.parse(jsonText) as Partial<GeminiAutofillResult>
    const meaningKo = normalizeKoreanMeaningLine(String(parsed.meaningKo ?? ''))
    const altMeaningsKo = Array.isArray(parsed.altMeaningsKo)
      ? parsed.altMeaningsKo
          .map((line) => normalizeKoreanMeaningLine(String(line)))
          .filter(Boolean)
          .slice(0, 2)
      : []
    const exampleEn = toSentenceCase(String(parsed.exampleEn ?? '').trim())
    const exampleKo = normalizeKoreanMeaningLine(String(parsed.exampleKo ?? ''))
    const definitionHint = String(parsed.definitionHint ?? '').trim()
    const parsedItemType =
      parsed.itemType === 'vocabulary' || parsed.itemType === 'expression' || parsed.itemType === 'idiom'
        ? parsed.itemType
        : undefined
    if (!meaningKo || !exampleEn) {
      lastError = 'empty-fields'
      continue
    }
    return { result: { meaningKo, altMeaningsKo, exampleEn, exampleKo, definitionHint, itemType: parsedItemType } }
    } catch {
      lastError = 'fetch-failed'
    }
  }
  return { result: null, error: lastError || 'unknown' }
}

function inferItemTypeAuto(phrase: string, definitionHint = ''): ItemType {
  const trimmed = phrase.trim()
  if (!trimmed) return 'vocabulary'
  if (!/\s/.test(trimmed)) return 'vocabulary'
  const hint = definitionHint.toLowerCase()
  if (/\b(idiom|idiomatic|figurative|slang|colloquial)\b/.test(hint)) return 'idiom'
  return 'expression'
}

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [items, setItems] = useState<StudyItem[]>([])
  const [profiles, setProfiles] = useState<CardInfoProfile[]>([])
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [syncLoading, setSyncLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'account' | 'profiles'>('account')
  const [settingsMsg, setSettingsMsg] = useState('')
  const [profileEditor, setProfileEditor] = useState<{
    id: string | null
    name: string
    show: string
    episode: string
    tags: string
    difficulty: 1 | 2 | 3
    notes: string
    deck: string
  }>({
    id: null,
    name: '',
    show: '',
    episode: '',
    tags: '',
    difficulty: 2,
    notes: '',
    deck: '기본 덱',
  })
  const [boardDragOverStatus, setBoardDragOverStatus] = useState<Status | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all')
  const [itemTypeFilter, setItemTypeFilter] = useState<'all' | ItemType>('all')
  const [listShowFilter, setListShowFilter] = useState<string>('all')
  const [listSort, setListSort] = useState<ListSort>('latest')

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [inputTab, setInputTab] = useState<InputTab>('text')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formAiProvider, setFormAiProvider] = useState<AiProvider>(DEFAULT_APP_SETTINGS.defaultAiProvider)
  const [isAutoFilling, setIsAutoFilling] = useState(false)
  const [autoFillMsg, setAutoFillMsg] = useState('')

  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null)
  const [ocrLines, setOcrLines] = useState<string[]>([])
  const [ocrLineSelected, setOcrLineSelected] = useState<number[]>([])
  const [ocrError, setOcrError] = useState('')
  const [ocrProgress, setOcrProgress] = useState(0)
  const [isOcrRunning, setIsOcrRunning] = useState(false)
  const [ocrDragOver, setOcrDragOver] = useState(false)
  const ocrFileInputRef = useRef<HTMLInputElement>(null)

  const resetOcrState = useCallback(() => {
    setOcrPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setOcrLines([])
    setOcrLineSelected([])
    setOcrError('')
    setOcrProgress(0)
    setIsOcrRunning(false)
    setOcrDragOver(false)
  }, [])

  const loadOcrImageFile = useCallback((file: File | null | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setOcrError('이미지 파일만 지원합니다 (PNG, JPEG, WebP 등).')
      return
    }
    setOcrError('')
    setOcrLines([])
    setOcrLineSelected([])
    setOcrPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
  }, [])

  const toggleOcrLine = (index: number) => {
    setOcrLineSelected((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index].sort((a, b) => a - b),
    )
  }

  const applyOcrSelectionToPhrase = () => {
    if (ocrLineSelected.length === 0) return
    const phrase = ocrLineSelected
      .map((i) => ocrLines[i] ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (phrase) setForm((prev) => ({ ...prev, phrase }))
  }

  const runOcrRecognize = async () => {
    if (!ocrPreviewUrl || isOcrRunning) return
    setIsOcrRunning(true)
    setOcrError('')
    setOcrProgress(0)
    setOcrLines([])
    setOcrLineSelected([])
    try {
      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker('eng', undefined, {
        logger: (m) => {
          if (typeof m.progress === 'number') {
            setOcrProgress(Math.min(100, Math.round(m.progress * 100)))
          }
        },
      })
      const { data } = await worker.recognize(ocrPreviewUrl)
      await worker.terminate()
      const text = data.text ?? ''
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      setOcrLines(lines)
      if (lines.length === 0) {
        setOcrError('인식된 텍스트가 없습니다. 더 선명한 이미지로 다시 시도해 보세요.')
      }
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'OCR 처리 중 오류가 발생했습니다.')
    } finally {
      setIsOcrRunning(false)
      setOcrProgress(0)
    }
  }

  const [cardIndex, setCardIndex] = useState(0)
  const [cardSlideTick, setCardSlideTick] = useState(0)
  const [cardTimerProgress, setCardTimerProgress] = useState(1)
  const [activeDeck, setActiveDeck] = useState<string>('all')
  const [openedDeck, setOpenedDeck] = useState<string | null>(null)
  const [cardFlipped, setCardFlipped] = useState(false)
  const [cardEnterDir, setCardEnterDir] = useState<CardEnterDir>('next')
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const googleProviderRef = useRef(new GoogleAuthProvider())
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const importFileRef = useRef<HTMLInputElement>(null)
  const swipeStartXRef = useRef<number | null>(null)
  const swipeStartYRef = useRef<number | null>(null)
  const swipePointerIdRef = useRef<number | null>(null)
  const suppressCardClickRef = useRef(false)
  const [weekStart, setWeekStart] = useState(() => {
    const today = new Date()
    const day = today.getDay()
    const diff = day === 0 ? -6 : 1 - day
    return addDays(today, diff)
  })

  const profileMap = useMemo(() => {
    const map = new Map<string, CardInfoProfile>()
    for (const profile of profiles) map.set(profile.id, profile)
    return map
  }, [profiles])

  const writeLocalData = useCallback(
    (nextItems: StudyItem[], nextProfiles: CardInfoProfile[], nextSettings: AppSettings) => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        items: nextItems,
        profiles: nextProfiles,
        settings: nextSettings,
      }),
    )
    },
    [],
  )

  useEffect(() => {
    if (!firebaseReady || !auth) {
      setAuthLoading(false)
      return
    }
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setAuthUser(nextUser)
      setAuthLoading(false)
      setAuthError('')
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!authUser || !db) {
      const cached = loadLocalData()
      setItems(cached.items)
      setProfiles(cached.profiles)
      setAppSettings(cached.settings)
      setIsAccountMenuOpen(false)
      return
    }
    setSyncLoading(true)
    const ref = doc(db, 'users', authUser.uid, 'appData', FIREBASE_DOC_KEY)
    const unsub = onSnapshot(
      ref,
      async (snap) => {
        const data = snap.data() as
          | { items?: StudyItem[]; profiles?: CardInfoProfile[]; settings?: AppSettings }
          | undefined
        const next = normalizeItems(data?.items)
        const nextProfiles = normalizeProfiles(data?.profiles)
        const nextSettings = normalizeAppSettings(data?.settings)
        const nextProfileMap = new Map(nextProfiles.map((profile) => [profile.id, profile]))
        const merged = next.map((item) => {
          if (!item.profileId) return item
          const profile = nextProfileMap.get(item.profileId)
          if (!profile) return { ...item, profileId: null }
          return {
            ...item,
            show: profile.show,
            episode: profile.episode,
            tags: [...profile.tags],
            difficulty: profile.difficulty,
            notes: profile.notes,
            deck: profile.deck || '기본 덱',
          }
        })
        if (next.length > 0) {
          setItems(merged)
          setProfiles(nextProfiles)
          setAppSettings(nextSettings)
          writeLocalData(merged, nextProfiles, nextSettings)
        } else {
          const cached = loadLocalData()
          const seed = cached.items.length > 0 ? cached.items : SAMPLE_ITEMS
          const seedProfiles = nextProfiles.length > 0 ? nextProfiles : cached.profiles
          const seedSettings = nextSettings.defaultAiProvider ? nextSettings : cached.settings
          const seedProfileMap = new Map(seedProfiles.map((profile) => [profile.id, profile]))
          const hydratedSeed = seed.map((item) => {
            if (!item.profileId) return item
            const profile = seedProfileMap.get(item.profileId)
            if (!profile) return { ...item, profileId: null }
            return {
              ...item,
              show: profile.show,
              episode: profile.episode,
              tags: [...profile.tags],
              difficulty: profile.difficulty,
              notes: profile.notes,
              deck: profile.deck,
            }
          })
          setItems(hydratedSeed)
          setProfiles(seedProfiles)
          setAppSettings(seedSettings)
          await setDoc(
            ref,
            { items: hydratedSeed, profiles: seedProfiles, settings: seedSettings, updatedAt: serverTimestamp() },
            { merge: true },
          )
          writeLocalData(hydratedSeed, seedProfiles, seedSettings)
        }
        setSyncError('')
        setSyncLoading(false)
      },
      (err) => {
        const cached = loadLocalData()
        setItems(cached.items.length > 0 ? cached.items : SAMPLE_ITEMS)
        setProfiles(cached.profiles)
        setAppSettings(cached.settings)
        setSyncError(err.message || '클라우드 동기화에 실패했습니다.')
        setSyncLoading(false)
      },
    )
    return () => unsub()
  }, [authUser, writeLocalData])

  const persistAll = async (
    nextItems: StudyItem[],
    nextProfiles: CardInfoProfile[],
    nextSettings: AppSettings,
  ) => {
    setItems(nextItems)
    setProfiles(nextProfiles)
    setAppSettings(nextSettings)
    writeLocalData(nextItems, nextProfiles, nextSettings)
    if (!authUser || !db) return
    try {
      await setDoc(
        doc(db, 'users', authUser.uid, 'appData', FIREBASE_DOC_KEY),
        { items: nextItems, profiles: nextProfiles, settings: nextSettings, updatedAt: serverTimestamp() },
        { merge: true },
      )
      setSyncError('')
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : '클라우드 저장 중 오류가 발생했습니다.')
    }
  }

  const persist = async (nextItems: StudyItem[]) => persistAll(nextItems, profiles, appSettings)

  const upsertProfile = async (
    profileInput: Omit<CardInfoProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string | null },
  ) => {
    const now = new Date().toISOString().slice(0, 10)
    let updatedProfile: CardInfoProfile
    const existing = profileInput.id ? profiles.find((p) => p.id === profileInput.id) ?? null : null
    if (existing) {
      updatedProfile = { ...existing, ...profileInput, id: existing.id, updatedAt: now }
    } else {
      updatedProfile = { ...profileInput, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
    }
    const nextProfiles = existing
      ? profiles.map((p) => (p.id === existing.id ? updatedProfile : p))
      : [updatedProfile, ...profiles]
    const nextItems = items.map((item) =>
      item.profileId === updatedProfile.id
        ? {
            ...item,
            show: updatedProfile.show,
            episode: updatedProfile.episode,
            tags: [...updatedProfile.tags],
            difficulty: updatedProfile.difficulty,
            notes: updatedProfile.notes,
            deck: updatedProfile.deck,
          }
        : item,
    )
    await persistAll(nextItems, nextProfiles, appSettings)
    return updatedProfile
  }

  const deleteProfile = async (profileId: string) => {
    const nextProfiles = profiles.filter((profile) => profile.id !== profileId)
    const nextItems = items.map((item) =>
      item.profileId === profileId
        ? {
            ...item,
            profileId: null,
          }
        : item,
    )
    await persistAll(nextItems, nextProfiles, appSettings)
  }

  const listShowOptions = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      const show = item.show?.trim()
      if (show) set.add(show)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items])

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = items.filter((item) => {
      const itemType = item.itemType ?? inferItemType(item.phrase)
      if (statusFilter !== 'all' && item.status !== statusFilter) return false
      if (itemTypeFilter !== 'all' && itemType !== itemTypeFilter) return false
      if (listShowFilter !== 'all') {
        if (listShowFilter === '__none__') {
          if (item.show?.trim()) return false
        } else if ((item.show ?? '').trim() !== listShowFilter) {
          return false
        }
      }
      if (!q) return true
      return (
        item.phrase.toLowerCase().includes(q) ||
        item.translation.toLowerCase().includes(q) ||
        item.example.toLowerCase().includes(q) ||
        item.show.toLowerCase().includes(q) ||
        item.tags.some((tag) => tag.toLowerCase().includes(q))
      )
    })
    const sorted = [...rows].sort((a, b) => {
      if (listSort === 'latest') return b.createdAt.localeCompare(a.createdAt)
      if (listSort === 'oldest') return a.createdAt.localeCompare(b.createdAt)
      return a.phrase.localeCompare(b.phrase, 'en', { sensitivity: 'base' })
    })
    return sorted
  }, [items, query, statusFilter, itemTypeFilter, listShowFilter, listSort])

  const stats = useMemo(
    () => ({
      total: items.length,
      learning: items.filter((item) => item.status === 'learning').length,
      mastered: items.filter((item) => item.status === 'mastered').length,
      shows: new Set(items.map((item) => item.show).filter(Boolean)).size,
      vocabulary: items.filter((item) => (item.itemType ?? inferItemType(item.phrase)) === 'vocabulary').length,
      phraseLike: items.filter((item) => {
        const type = item.itemType ?? inferItemType(item.phrase)
        return type === 'expression' || type === 'idiom'
      }).length,
    }),
    [items],
  )

  const boardColumnCounts = useMemo(() => {
    const c = { new: 0, learning: 0, mastered: 0 }
    for (const item of items) {
      const itemType = item.itemType ?? inferItemType(item.phrase)
      if (itemTypeFilter !== 'all' && itemType !== itemTypeFilter) continue
      c[item.status]++
    }
    return c
  }, [items, itemTypeFilter])

  const dashboardRecent = useMemo(() => {
    return [...items]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6)
  }, [items])

  const dashboardDue = useMemo(() => {
    return items
      .filter((item) => item.status !== 'mastered')
      .sort((a, b) => {
        const aScore = (a.status === 'learning' ? 2 : 1) + a.reviewCount
        const bScore = (b.status === 'learning' ? 2 : 1) + b.reviewCount
        return bScore - aScore
      })
      .slice(0, 6)
  }, [items])

  const dashboardStudyByType = useMemo(() => {
    const candidates = items.filter((item) => item.status !== 'mastered')
    return {
      vocabulary: candidates.filter((item) => (item.itemType ?? inferItemType(item.phrase)) === 'vocabulary')
        .length,
      expression: candidates.filter((item) => (item.itemType ?? inferItemType(item.phrase)) === 'expression')
        .length,
      idiom: candidates.filter((item) => (item.itemType ?? inferItemType(item.phrase)) === 'idiom').length,
      total: candidates.length,
    }
  }, [items])

  const deckNames = useMemo(() => {
    return [...new Set(items.map((item) => item.deck || '기본 덱'))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [items])

  const deckCountMap = useMemo(() => {
    const map: Record<string, number> = {}
    for (const item of items) {
      const key = item.deck || '기본 덱'
      map[key] = (map[key] ?? 0) + 1
    }
    return map
  }, [items])

  const cardItems = useMemo(() => {
    return items.filter((item) => {
      const passDeck = activeDeck === 'all' ? true : item.deck === activeDeck
      const passLearning = item.status !== 'mastered' || item.reviewCount < 3
      const itemType = item.itemType ?? inferItemType(item.phrase)
      const passType = itemTypeFilter === 'all' ? true : itemType === itemTypeFilter
      return passDeck && passLearning && passType
    })
  }, [items, activeDeck, itemTypeFilter])

  const currentCard = cardItems[cardIndex] ?? null
  const detailItem = detailId ? items.find((item) => item.id === detailId) ?? null : null
  const detailTranslation = splitTranslationParts(detailItem?.translation ?? '')
  const detailPhraseWords = useMemo(
    () => splitPhraseWords(detailItem?.phrase ?? ''),
    [detailItem?.phrase],
  )
  const selectedFormProfile = form.profileId ? profileMap.get(form.profileId) ?? null : null
  const isFormUsingProfile = Boolean(selectedFormProfile)
  const profileUsageCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const item of items) {
      if (!item.profileId) continue
      map[item.profileId] = (map[item.profileId] ?? 0) + 1
    }
    return map
  }, [items])

  const showKeywords = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      const value = item.show.trim()
      if (value) set.add(value)
    }
    for (const profile of profiles) {
      const value = profile.show.trim()
      if (value) set.add(value)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items, profiles])

  const episodeKeywords = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      const value = item.episode.trim()
      if (value) set.add(value)
    }
    for (const profile of profiles) {
      const value = profile.episode.trim()
      if (value) set.add(value)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items, profiles])

  const deckKeywords = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      const value = item.deck.trim()
      if (value) set.add(value)
    }
    for (const profile of profiles) {
      const value = profile.deck.trim()
      if (value) set.add(value)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items, profiles])

  const tagKeywords = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      for (const tag of item.tags) {
        const value = tag.trim()
        if (value) set.add(value)
      }
    }
    for (const profile of profiles) {
      for (const tag of profile.tags) {
        const value = tag.trim()
        if (value) set.add(value)
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items, profiles])

  const calendarDays = useMemo(() => {
    const first = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1)
    const startWeekday = first.getDay()
    const start = new Date(first)
    start.setDate(first.getDate() - startWeekday)
    return Array.from({ length: 42 }, (_, i) => {
      const day = new Date(start)
      day.setDate(start.getDate() + i)
      return day
    })
  }, [calendarMonth])

  const itemsByDate = useMemo(() => {
    const map: Record<string, StudyItem[]> = {}
    for (const item of items) {
      if (!item.scheduledDate) continue
      if (!map[item.scheduledDate]) map[item.scheduledDate] = []
      map[item.scheduledDate].push(item)
    }
    return map
  }, [items])

  const unscheduledItems = useMemo(
    () => items.filter((item) => !item.scheduledDate),
    [items],
  )

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [weekStart])

  const weekItemsByDate = useMemo(() => {
    const map: Record<string, StudyItem[]> = {}
    for (const day of weekDays) map[toDateKey(day)] = []
    for (const item of items) {
      if (!item.scheduledDate) continue
      if (!map[item.scheduledDate]) continue
      map[item.scheduledDate].push(item)
    }
    return map
  }, [items, weekDays])

  // appSettings가 Firebase에서 로드되면 formAiProvider도 동기화
  useEffect(() => {
    if (!isAddOpen) {
      setFormAiProvider(appSettings.defaultAiProvider)
    }
  }, [appSettings.defaultAiProvider, isAddOpen])

  useEffect(() => {
    if (!isAccountMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setIsAccountMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [isAccountMenuOpen])

  useEffect(() => {
    if (activeDeck === 'all') return
    if (!deckNames.includes(activeDeck)) {
      setActiveDeck('all')
      setCardIndex(0)
      setCardFlipped(false)
    }
  }, [activeDeck, deckNames])

  useEffect(() => {
    if (!openedDeck || openedDeck === 'all') return
    if (!deckNames.includes(openedDeck)) {
      setOpenedDeck(null)
    }
  }, [openedDeck, deckNames])

  useEffect(() => {
    if (cardItems.length === 0) {
      setCardIndex(0)
      return
    }
    if (cardIndex >= cardItems.length) {
      setCardIndex(0)
    }
  }, [cardItems.length, cardIndex])

  useEffect(() => {
    if (!isAddOpen || inputTab !== 'ocr') return
    const onPaste = (event: ClipboardEvent) => {
      const clipItems = event.clipboardData?.items
      if (!clipItems?.length) return
      for (const item of clipItems) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          event.preventDefault()
          loadOcrImageFile(item.getAsFile())
          return
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [isAddOpen, inputTab, loadOcrImageFile])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        resetOcrState()
        setIsAddOpen(false)
        setIsDetailOpen(false)
      }
      if (page === 'cards' && !isAddOpen && !isDetailOpen) {
        if (event.key === ' ') {
          event.preventDefault()
          setCardFlipped((prev) => !prev)
        }
        if (event.key === 'ArrowLeft') prevCard()
        if (event.key === 'ArrowRight') nextCard()
        if (event.key === '1') rateCard('again')
        if (event.key === '2') rateCard('good')
        if (event.key === '3') rateCard('easy')
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [page, isAddOpen, isDetailOpen, currentCard, resetOcrState])

  const openCreateModal = (deckPreset?: string) => {
    resetOcrState()
    setEditingId(null)
    setForm({ ...EMPTY_FORM, deck: deckPreset || EMPTY_FORM.deck, profileId: '' })
    setFormAiProvider(appSettings.defaultAiProvider)
    setInputTab('text')
    setIsAddOpen(true)
  }

  const openCreateModalWithPhrase = (phrase: string, sourceItem?: StudyItem) => {
    const deck = (sourceItem?.deck ?? EMPTY_FORM.deck).trim() || EMPTY_FORM.deck
    resetOcrState()
    setEditingId(null)
    setForm({
      ...EMPTY_FORM,
      phrase: phrase.trim(),
      show: sourceItem?.show ?? '',
      episode: sourceItem?.episode ?? '',
      tags: sourceItem ? sourceItem.tags.join(', ') : '',
      difficulty: sourceItem?.difficulty ?? EMPTY_FORM.difficulty,
      notes: sourceItem?.notes ?? '',
      deck,
      profileId: sourceItem?.profileId ?? '',
      itemType: 'vocabulary',
    })
    setFormAiProvider(appSettings.defaultAiProvider)
    setInputTab('text')
    setIsDetailOpen(false)
    setIsAddOpen(true)
  }

  const openEditModal = (item: StudyItem) => {
    resetOcrState()
    setEditingId(item.id)
    setForm(toFormState(item))
    setFormAiProvider(appSettings.defaultAiProvider)
    setInputTab('text')
    setIsDetailOpen(false)
    setIsAddOpen(true)
  }

  const openDetailModal = (id: string) => {
    setDetailId(id)
    setIsDetailOpen(true)
  }

  const closeAddModal = () => {
    resetOcrState()
    setIsAddOpen(false)
  }

  const onFormProfileChange = (profileId: string) => {
    if (!profileId) {
      setForm((prev) => ({ ...prev, profileId: '' }))
      return
    }
    const profile = profileMap.get(profileId)
    if (!profile) return
    setForm((prev) => ({
      ...prev,
      profileId,
      show: profile.show,
      episode: profile.episode,
      tags: profile.tags.join(', '),
      difficulty: profile.difficulty,
      notes: profile.notes,
      deck: profile.deck,
    }))
  }

  const saveProfileFromCurrentForm = async () => {
    const name = window.prompt('프로파일 이름을 입력하세요')
    if (!name || !name.trim()) return
    const nextProfile = await upsertProfile({
      name: name.trim(),
      show: form.show.trim(),
      episode: form.episode.trim(),
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      difficulty: form.difficulty,
      notes: form.notes.trim(),
      deck: form.deck.trim() || '기본 덱',
    })
    setForm((prev) => ({ ...prev, profileId: nextProfile.id }))
    setSettingsMsg(`프로파일 "${nextProfile.name}" 저장 완료`)
  }

  const startEditProfile = (profile: CardInfoProfile) => {
    setSettingsTab('profiles')
    setProfileEditor({
      id: profile.id,
      name: profile.name,
      show: profile.show,
      episode: profile.episode,
      tags: profile.tags.join(', '),
      difficulty: profile.difficulty,
      notes: profile.notes,
      deck: profile.deck,
    })
  }

  const resetProfileEditor = () => {
    setProfileEditor({
      id: null,
      name: '',
      show: '',
      episode: '',
      tags: '',
      difficulty: 2,
      notes: '',
      deck: '기본 덱',
    })
  }

  const submitProfileEditor = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = profileEditor.name.trim()
    if (!trimmedName) {
      setSettingsMsg('프로파일 이름을 입력해 주세요.')
      return
    }
    const saved = await upsertProfile({
      id: profileEditor.id,
      name: trimmedName,
      show: profileEditor.show.trim(),
      episode: profileEditor.episode.trim(),
      tags: profileEditor.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      difficulty: profileEditor.difficulty,
      notes: profileEditor.notes.trim(),
      deck: profileEditor.deck.trim() || '기본 덱',
    })
    setSettingsMsg(`프로파일 "${saved.name}" 저장 완료`)
    setProfileEditor({
      id: saved.id,
      name: saved.name,
      show: saved.show,
      episode: saved.episode,
      tags: saved.tags.join(', '),
      difficulty: saved.difficulty,
      notes: saved.notes,
      deck: saved.deck,
    })
  }

  const updateDefaultAiProvider = async (provider: AiProvider) => {
    const nextSettings: AppSettings = { ...appSettings, defaultAiProvider: provider }
    await persistAll(items, profiles, nextSettings)
    setSettingsMsg(`기본 자동 생성 모델을 "${AI_PROVIDER_LABEL[provider]}"로 저장했습니다.`)
  }

  const updateStatus = (id: string, status: Status) => {
    const next = items.map((item) => (item.id === id ? { ...item, status } : item))
    persist(next)
    if (isDetailOpen) setDetailId(id)
  }

  const removeItem = (id: string) => {
    const next = items.filter((item) => item.id !== id)
    persist(next)
    setIsDetailOpen(false)
  }

  const removeItemFromDeck = (id: string) => {
    const next = items.filter((item) => item.id !== id)
    persist(next)
  }

  const moveMonth = (delta: number) => {
    setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }

  const scheduleItem = (itemId: string, dateKey: string) => {
    const next = items.map((item) =>
      item.id === itemId ? { ...item, scheduledDate: dateKey } : item,
    )
    persist(next)
  }

  const clearSchedule = (itemId: string) => {
    const next = items.map((item) =>
      item.id === itemId ? { ...item, scheduledDate: undefined } : item,
    )
    persist(next)
  }

  const onBoardCardDragStart = (event: ReactDragEvent<HTMLElement>, itemId: string) => {
    event.dataTransfer.setData('text/plain', itemId)
    event.dataTransfer.effectAllowed = 'move'
  }

  const onBoardColumnDragOver = (event: ReactDragEvent<HTMLElement>, status: Status) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (boardDragOverStatus !== status) setBoardDragOverStatus(status)
  }

  const onBoardColumnDrop = (event: ReactDragEvent<HTMLElement>, status: Status) => {
    event.preventDefault()
    const itemId = event.dataTransfer.getData('text/plain')
    if (itemId) updateStatus(itemId, status)
    setBoardDragOverStatus(null)
  }

  const openedDeckItems = useMemo(() => {
    if (!openedDeck) return []
    if (openedDeck === 'all') return items
    return items.filter((item) => item.deck === openedDeck)
  }, [items, openedDeck])

  const openedDeckGroups = useMemo(() => {
    if (!openedDeck) return []
    if (openedDeck !== 'all') {
      return [{ deck: openedDeck, items: openedDeckItems }]
    }
    const map: Record<string, StudyItem[]> = {}
    for (const item of openedDeckItems) {
      const key = item.deck || '기본 덱'
      if (!map[key]) map[key] = []
      map[key].push(item)
    }
    return Object.entries(map)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([deck, grouped]) => ({ deck, items: grouped }))
  }, [openedDeck, openedDeckItems])

  const onSubmitAdd = (event: FormEvent) => {
    event.preventDefault()
    if (!form.phrase.trim() || !form.translation.trim()) return

    const selectedProfileId = form.profileId.trim()
    const selectedProfile = selectedProfileId ? profileMap.get(selectedProfileId) ?? null : null
    const payload = {
      phrase: form.phrase.trim(),
      translation: form.translation.trim(),
      example: form.example.trim(),
      show: selectedProfile ? selectedProfile.show : form.show.trim(),
      episode: selectedProfile ? selectedProfile.episode : form.episode.trim(),
      tags: selectedProfile
        ? [...selectedProfile.tags]
        : form.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
      difficulty: selectedProfile ? selectedProfile.difficulty : form.difficulty,
      notes: selectedProfile ? selectedProfile.notes : form.notes.trim(),
      deck: selectedProfile ? selectedProfile.deck : form.deck.trim() || '기본 덱',
      profileId: selectedProfile ? selectedProfile.id : null,
      itemType: inferItemTypeAuto(form.phrase, ''),
    }

    if (editingId) {
      const next = items.map((item) =>
        item.id === editingId
          ? {
              ...item,
              ...payload,
            }
          : item,
      )
      persist(next)
    } else {
      const next: StudyItem[] = [
        {
          id: crypto.randomUUID(),
          ...payload,
          status: 'new',
          reviewCount: 0,
          createdAt: new Date().toISOString().slice(0, 10),
        },
        ...items,
      ]
      persist(next)
    }
    setIsAddOpen(false)
    resetOcrState()
  }

  const autoFillFromEnglish = async (forceUpdate = false, provider: AiProvider = formAiProvider) => {
    const phrase = form.phrase.trim()
    if (!phrase || isAutoFilling) return
    const inferredType = inferItemTypeAuto(phrase)
    const phraseOverride = PHRASE_USAGE_OVERRIDES[normalizeForContains(phrase)]

    setIsAutoFilling(true)
    setAutoFillMsg('자동 생성 중...')

    let koMeaning = ''
    let enExample = ''
    let koExample = ''
    let altMeanings: string[] = []
    let definitionHint = ''
    let usedGemini = false

    try {
      const transRes = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(phrase)}&langpair=en|ko`,
      )
      if (transRes.ok) {
        const transData = (await transRes.json()) as {
          responseData?: { translatedText?: string }
          matches?: Array<{ translation?: string }>
        }
        const allCandidates = [
          transData.responseData?.translatedText?.trim() || '',
          ...(transData.matches ?? []).map((m) => m.translation?.trim() || ''),
        ]
          .map((line) => normalizeKoreanMeaningLine(line))
          .filter(Boolean)
        koMeaning =
          inferredType === 'vocabulary' ? pickWordMeaningCandidate(allCandidates) : (allCandidates[0] ?? '')
        altMeanings = allCandidates
          .filter((line) => line !== koMeaning)
          .slice(0, 2)
      }
    } catch {
      // Ignore translation API failures and fallback below.
    }

    try {
      const lookupCandidates =
        inferredType === 'vocabulary' ? [phrase, phrase.split(/\s+/)[0] ?? ''] : [phrase]
      for (const candidate of lookupCandidates) {
        const keyword = candidate.replace(/[^a-zA-Z'-\s]/g, '').trim()
        if (!keyword) continue
        const dictRes = await fetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(keyword)}`,
        )
        if (!dictRes.ok) continue
        const dictData = (await dictRes.json()) as Array<{
          meanings?: Array<{ definitions?: Array<{ example?: string; definition?: string }> }>
        }>
        const examples: string[] = []
        const definitions: string[] = []
        for (const entry of dictData) {
          for (const meaning of entry.meanings ?? []) {
            for (const def of meaning.definitions ?? []) {
              if (def.example) examples.push(def.example)
              if (def.definition) definitions.push(def.definition)
            }
          }
        }
        const matchedExample = inferredType !== 'vocabulary'
          ? examples.find((line) => includesPhrase(line, phrase)) || ''
          : examples.find((line) => line.toLowerCase().includes(phrase.toLowerCase())) ||
            examples[0] ||
            ''
        if (matchedExample) enExample = toSentenceCase(matchedExample)
        if (definitions[0]) definitionHint = definitions[0]
        if (enExample) break
      }
    } catch {
      // Ignore dictionary API failures and fallback below.
    }

    if (inferredType !== 'vocabulary' && definitionHint) {
      const meaningFromDefinition = await translateEnglishToKorean(definitionHint)
      if (meaningFromDefinition) {
        koMeaning = meaningFromDefinition
        altMeanings = altMeanings.filter((line) => line !== koMeaning)
      }
    }

    const shouldUseGemini = provider === 'gemini' && Boolean(GEMINI_API_KEY)
    const geminiResponse = shouldUseGemini
      ? await generateMeaningAndExampleWithGemini(phrase, inferredType)
      : { result: null, error: provider === 'gemini' ? 'missing-key' : undefined }
    const geminiResult = geminiResponse.result
    let resolvedItemType = inferredType
    if (geminiResult) {
      koMeaning = geminiResult.meaningKo
      altMeanings = geminiResult.altMeaningsKo
      enExample = geminiResult.exampleEn
      if (geminiResult.exampleKo) koExample = geminiResult.exampleKo
      if (geminiResult.definitionHint) definitionHint = geminiResult.definitionHint
      if (geminiResult.itemType) resolvedItemType = geminiResult.itemType
      usedGemini = true
    }
    if (!geminiResult && phraseOverride && inferredType !== 'vocabulary') {
      koMeaning = phraseOverride.meaningKo
      altMeanings = phraseOverride.altMeaningsKo ?? []
      enExample = phraseOverride.exampleEn
      koExample = phraseOverride.exampleKo
      if (phraseOverride.itemType) resolvedItemType = phraseOverride.itemType
    }
    if (!geminiResult) {
      resolvedItemType = inferItemTypeAuto(phrase, definitionHint)
    }

    if (!koMeaning) {
      koMeaning = `"${phrase}"의 의미를 확인해 주세요.`
    }
    if (!enExample) {
      enExample = inferredType !== 'vocabulary'
        ? buildPhraseFallbackExample(phrase)
        : buildWordFallbackExample(phrase, definitionHint)
    }
    if (inferredType !== 'vocabulary' && !includesPhrase(enExample, phrase)) {
      enExample = buildPhraseFallbackExample(phrase)
    }

    try {
      const exRes = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(enExample)}&langpair=en|ko`,
      )
      if (exRes.ok) {
        const exData = (await exRes.json()) as {
          responseData?: { translatedText?: string }
        }
        koExample = sanitizeTranslationApiText(exData.responseData?.translatedText?.trim() || '')
      }
    } catch {
      // Ignore example translation failure; keep English example.
    }

    const meaningLines = [koMeaning, ...altMeanings].filter(Boolean)
    const translationText =
      meaningLines.length === 1
        ? meaningLines[0]
        : `${meaningLines[0]}\n\n대체 표현:\n- ${meaningLines.slice(1).join('\n- ')}`

    const exampleText = koExample ? `${enExample}\n→ ${koExample}` : enExample

    setForm((prev) => ({
      ...prev,
      translation: forceUpdate || !prev.translation.trim() ? translationText : prev.translation,
      example:
        forceUpdate || !prev.example.trim() || isLikelyAutoGeneratedExample(prev.example)
          ? exampleText
          : prev.example,
      itemType: resolvedItemType,
    }))

    const providerMsg =
      provider === 'gemini' && !GEMINI_API_KEY
        ? `${AI_PROVIDER_LABEL.default} 사용 (Gemini 키 없음)`
        : usedGemini
          ? `${AI_PROVIDER_LABEL.gemini} 사용`
          : provider === 'gemini'
            ? `${AI_PROVIDER_LABEL.default} 사용 (Gemini 실패: ${geminiResponse.error ?? 'unknown'})`
            : `${AI_PROVIDER_LABEL.default} 사용`
    setAutoFillMsg(
      forceUpdate
        ? `뜻/예문을 최신 자동 생성 내용으로 업데이트했습니다. (${providerMsg})`
        : `뜻/예문 자동 채우기 완료 (${providerMsg}).`,
    )
    setIsAutoFilling(false)
  }

  const nextCard = useCallback(() => {
    if (cardItems.length === 0) return
    setCardEnterDir('next')
    setCardIndex((prev) => (prev + 1 >= cardItems.length ? 0 : prev + 1))
    setCardFlipped(false)
    setCardSlideTick((t) => t + 1)
  }, [cardItems.length])

  const prevCard = useCallback(() => {
    if (cardItems.length === 0) return
    setCardEnterDir('prev')
    setCardIndex((prev) => (prev - 1 < 0 ? cardItems.length - 1 : prev - 1))
    setCardFlipped(false)
    setCardSlideTick((t) => t + 1)
  }, [cardItems.length])

  useEffect(() => {
    if (page !== 'cards' || cardItems.length === 0 || isAddOpen || isDetailOpen) {
      setCardTimerProgress(1)
      return
    }
    setCardTimerProgress(1)
    const start = Date.now()
    const intervalId = window.setInterval(() => {
      const elapsed = Date.now() - start
      setCardTimerProgress(Math.max(0, 1 - elapsed / CARD_AUTO_ADVANCE_MS))
    }, 32)
    const timeoutId = window.setTimeout(() => {
      clearInterval(intervalId)
      nextCard()
    }, CARD_AUTO_ADVANCE_MS)
    return () => {
      clearInterval(intervalId)
      clearTimeout(timeoutId)
    }
  }, [page, cardIndex, cardSlideTick, cardItems.length, isAddOpen, isDetailOpen, nextCard])

  const rateCard = (rating: CardRating) => {
    if (!currentCard) return
    if (rating === 'skip') {
      nextCard()
      return
    }
    const status: Status = rating === 'easy' ? 'mastered' : rating === 'good' ? 'learning' : 'new'
    const next = items.map((item) =>
      item.id === currentCard.id
        ? {
            ...item,
            status,
            reviewCount: item.reviewCount + 1,
            lastReviewedAt: new Date().toISOString().slice(0, 10),
          }
        : item,
    )
    persist(next)
    nextCard()
  }

  const onCardSwipeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cardItems.length <= 1) return
    swipePointerIdRef.current = event.pointerId
    swipeStartXRef.current = event.clientX
    swipeStartYRef.current = event.clientY
  }

  const onCardSwipeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (swipePointerIdRef.current !== event.pointerId) return
    const startX = swipeStartXRef.current
    const startY = swipeStartYRef.current
    swipePointerIdRef.current = null
    swipeStartXRef.current = null
    swipeStartYRef.current = null
    if (startX === null || startY === null) return

    const deltaX = event.clientX - startX
    const deltaY = event.clientY - startY
    const horizontalEnough = Math.abs(deltaX) >= 50
    const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.2
    if (!horizontalEnough || !mostlyHorizontal) return

    suppressCardClickRef.current = true
    if (deltaX < 0) {
      nextCard()
    } else {
      prevCard()
    }
    window.setTimeout(() => {
      suppressCardClickRef.current = false
    }, 120)
  }

  const loginWithGoogle = async () => {
    if (!auth || !firebaseReady) return
    setAuthError('')
    try {
      await signInWithPopup(auth, googleProviderRef.current)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '구글 로그인에 실패했습니다.')
    }
  }

  const logout = async () => {
    if (!auth) return
    try {
      await signOut(auth)
      setItems([])
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '로그아웃에 실패했습니다.')
    }
  }

  const forceSyncNow = async () => {
    if (!authUser || !db) return
    setSyncLoading(true)
    setSettingsMsg('')
    try {
      await setDoc(
        doc(db, 'users', authUser.uid, 'appData', FIREBASE_DOC_KEY),
        { items, profiles, settings: appSettings, updatedAt: serverTimestamp() },
        { merge: true },
      )
      setSettingsMsg('클라우드 동기화를 완료했습니다.')
      setSyncError('')
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : '동기화에 실패했습니다.')
    } finally {
      setSyncLoading(false)
    }
  }

  const exportItemsJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      count: items.length,
      items,
      profiles,
      settings: appSettings,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `midani-study-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setSettingsMsg('백업 파일을 내보냈습니다.')
  }

  const importItemsJson = async (file: File | null) => {
    if (!file) return
    setSettingsMsg('')
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { items?: unknown; profiles?: unknown; settings?: unknown } | StudyItem[]
      const rawItems = Array.isArray(parsed) ? parsed : parsed.items
      const rawProfiles = Array.isArray(parsed) ? [] : parsed.profiles
      const rawSettings = Array.isArray(parsed) ? undefined : parsed.settings
      const next = normalizeItems(rawItems)
      const nextProfiles = normalizeProfiles(rawProfiles)
      const nextSettings = normalizeAppSettings(rawSettings)
      const hydratedNext = next.map((item) => {
        if (!item.profileId) return item
        const profile = nextProfiles.find((p) => p.id === item.profileId)
        if (!profile) return { ...item, profileId: null }
        return {
          ...item,
          show: profile.show,
          episode: profile.episode,
          tags: [...profile.tags],
          difficulty: profile.difficulty,
          notes: profile.notes,
          deck: profile.deck,
        }
      })
      if (next.length === 0) {
        setSettingsMsg('불러온 데이터에 카드가 없습니다.')
        return
      }
      await persistAll(hydratedNext, nextProfiles, nextSettings)
      setSettingsMsg(`${hydratedNext.length}개 카드를 불러왔습니다.`)
    } catch {
      setSettingsMsg('JSON 파일 형식이 올바르지 않습니다.')
    }
  }

  if (!firebaseReady) {
    return (
      <div className="auth-gate">
        <section className="auth-card">
          <h2>Firebase 설정이 필요합니다</h2>
          <p>
            외부 접속 동기화를 위해 Firebase 프로젝트를 연결해 주세요. 루트에 `.env` 파일을 만들고
            `.env.example` 키를 채운 뒤 다시 실행하면 됩니다.
          </p>
        </section>
      </div>
    )
  }

  if (authLoading) {
    return (
      <div className="auth-gate">
        <section className="auth-card">
          <h2>로그인 상태 확인 중…</h2>
        </section>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <h1>Mid/Ani English</h1>
          <p>미드/애니 영어 학습</p>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'active' : ''}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-account" ref={accountMenuRef}>
          {!authUser ? (
            <>
              <button type="button" className="account-login-link" onClick={loginWithGoogle}>
                Google 로그인
              </button>
              <p className="account-subtext">로그인하면 기기 간 동기화가 활성화됩니다.</p>
              {authError && <p className="auth-error">{authError}</p>}
            </>
          ) : (
            <>
              <button
                type="button"
                className="account-trigger"
                onClick={() => setIsAccountMenuOpen((prev) => !prev)}
              >
                <span className="account-avatar">{(authUser.displayName || authUser.email || 'U')[0]}</span>
                <span className="account-main">
                  <strong>{authUser.displayName || 'Google 사용자'}</strong>
                  <small>{authUser.email || '이메일 없음'}</small>
                </span>
                <span className="account-caret">{isAccountMenuOpen ? '▴' : '▾'}</span>
              </button>
              {isAccountMenuOpen && (
                <div className="account-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setIsSettingsOpen(true)
                      setSettingsTab('account')
                      resetProfileEditor()
                      setSettingsMsg('')
                      setIsAccountMenuOpen(false)
                    }}
                  >
                    설정
                  </button>
                  <button type="button" onClick={logout}>
                    로그아웃
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <h2>
              {page === 'list'
                ? '📋 전체 목록'
                : page === 'board'
                  ? '📌 카드 보드'
                  : '학습 노트'}
            </h2>
            <p>
              {page === 'list'
                ? '단어·구문·뜻을 한눈에 보고 복습해 보세요.'
                : page === 'board'
                  ? '상태별 칸에서 예문·복습·출처를 함께 보며 진행도를 관리해 보세요.'
                  : '프로토타입 기반 모달 + 카드 학습 흐름'}
            </p>
          </div>
          <div className="header-actions">
            <span className="sync-chip">
              {!authUser ? '로컬 모드' : syncLoading ? '동기화 중…' : '동기화 완료'}
            </span>
            {authUser && (
              <span className="user-chip" title={authUser.email ?? ''}>
                {authUser.displayName || authUser.email || 'Google 사용자'}
              </span>
            )}
            <button className="primary" onClick={() => openCreateModal()}>
              {page === 'list' || page === 'board' ? '+ 추가' : '단어 / 구문 추가'}
            </button>
          </div>
        </header>
        {syncError && <p className="sync-error-banner">동기화 오류: {syncError}</p>}

        {page === 'dashboard' && (
          <>
            <section className="dash-welcome">
              <div>
                <h3>👋 안녕하세요, Steve!</h3>
                <p>오늘도 영어 한 구문씩 꾸준히 💪</p>
              </div>
            </section>

            <section className="stats-grid">
              <article>
                <small>전체 등록</small>
                <strong className="c-accent">{stats.total}</strong>
                <span>
                  단어 {stats.vocabulary} · 구문 {stats.phraseLike}
                </span>
              </article>
              <article>
                <small>학습 중</small>
                <strong className="c-yellow">{stats.learning}</strong>
                <span>복습 필요</span>
              </article>
              <article>
                <small>완료</small>
                <strong className="c-green">{stats.mastered}</strong>
                <span>마스터!</span>
              </article>
              <article>
                <small>드라마 수</small>
                <strong className="c-blue">{stats.shows}</strong>
                <span>작품에서 수집</span>
              </article>
            </section>

            {dashboardDue.length > 0 && (
              <section className="due-banner">
                <div>
                  <h4>🔔 오늘의 학습</h4>
                  <p>학습할 카드가 {dashboardStudyByType.total}개 있어요!</p>
                  <div className="due-type-buttons">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setItemTypeFilter('vocabulary')
                        setPage('cards')
                      }}
                    >
                      Vocabulary ({dashboardStudyByType.vocabulary})
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setItemTypeFilter('expression')
                        setPage('cards')
                      }}
                    >
                      Expression ({dashboardStudyByType.expression})
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setItemTypeFilter('idiom')
                        setPage('cards')
                      }}
                    >
                      Idiom ({dashboardStudyByType.idiom})
                    </button>
                  </div>
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setItemTypeFilter('all')
                    setPage('cards')
                  }}
                >
                  지금 학습하기 →
                </button>
              </section>
            )}

            <section className="week-board">
              <div className="week-board-header">
                <div className="dash-title">🗓 주간 캘린더</div>
                <div className="week-nav">
                  <button className="secondary" onClick={() => setWeekStart((prev) => addDays(prev, -7))}>
                    ←
                  </button>
                  <strong>{weekRangeTitle(weekStart)}</strong>
                  <button className="secondary" onClick={() => setWeekStart((prev) => addDays(prev, 7))}>
                    →
                  </button>
                </div>
              </div>
              <div className="week-grid">
                {weekDays.map((day) => {
                  const key = toDateKey(day)
                  const dayItems = weekItemsByDate[key] ?? []
                  return (
                    <div
                      key={key}
                      className="week-cell"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault()
                        const itemId = event.dataTransfer.getData('text/plain')
                        if (itemId) scheduleItem(itemId, key)
                      }}
                    >
                      <div className="week-cell-head">
                        <span>{['월', '화', '수', '목', '금', '토', '일'][((day.getDay() + 6) % 7)]}</span>
                        <small>{day.getMonth() + 1}/{day.getDate()}</small>
                      </div>
                      <div className="week-cards">
                        {dayItems.map((item) => (
                          <div
                            key={item.id}
                            className="week-card"
                            draggable
                            onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                            onClick={() => openDetailModal(item.id)}
                          >
                            <strong>{item.phrase}</strong>
                            <small>{item.deck}</small>
                          </div>
                        ))}
                        {dayItems.length === 0 && <div className="week-empty">비어 있음</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="dash-columns">
              <div>
                <div className="dash-title">🕐 최근 추가</div>
                <div className="dash-list">
                  {dashboardRecent.map((item) => (
                    <button key={item.id} className="item-card" onClick={() => openDetailModal(item.id)}>
                      <strong>{item.phrase}</strong>
                      <p>{item.translation}</p>
                      <div className="chips">
                        <span>{STATUS_LABEL[item.status]}</span>
                        <span>{item.show || '작품 미입력'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="dash-title">🔔 복습 필요</div>
                <div className="dash-list">
                  {dashboardDue.map((item) => (
                    <button key={item.id} className="item-card" onClick={() => openDetailModal(item.id)}>
                      <strong>{item.phrase}</strong>
                      <p>{item.translation}</p>
                      <div className="chips">
                        <span>{STATUS_LABEL[item.status]}</span>
                        <span>{item.show || '작품 미입력'}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </>
        )}

        {page === 'list' && (
          <>
            <section className="list-toolbar">
              <input
                className="list-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="단어, 구문, 뜻 검색..."
              />
              <select
                className="list-filter-select"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as 'all' | Status)}
              >
                <option value="all">전체 상태</option>
                <option value="new">새 단어</option>
                <option value="learning">학습 중</option>
                <option value="mastered">완료</option>
              </select>
              <select
                className="list-filter-select"
                value={itemTypeFilter}
                onChange={(event) => setItemTypeFilter(event.target.value as 'all' | ItemType)}
              >
                <option value="all">Vocabulary+Expression+Idiom</option>
                <option value="vocabulary">Vocabulary</option>
                <option value="expression">Expression</option>
                <option value="idiom">Idiom</option>
              </select>
              <select
                className="list-filter-select"
                value={listShowFilter}
                onChange={(event) => setListShowFilter(event.target.value)}
              >
                <option value="all">전체 드라마</option>
                {listShowOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value="__none__">작품 미입력</option>
              </select>
              <select
                className="list-filter-select"
                value={listSort}
                onChange={(event) => setListSort(event.target.value as ListSort)}
              >
                <option value="latest">최신순</option>
                <option value="oldest">오래된순</option>
                <option value="phrase">가나다·ABC순</option>
              </select>
            </section>

            <div className="study-table-wrap">
              <table className="study-table">
                <thead>
                  <tr>
                    <th className="col-phrase">영어 단어 / 구문</th>
                    <th className="col-meaning">한국어 뜻</th>
                    <th className="col-source">출처</th>
                    <th className="col-tags">태그</th>
                    <th className="col-status">상태</th>
                    <th className="col-stars">난이도</th>
                    <th className="col-actions" aria-label="작업" />
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const koPrimary = splitTranslationParts(item.translation).primary || item.translation
                    const phraseWords = splitPhraseWords(item.phrase)
                    const itemType = item.itemType ?? inferItemType(item.phrase)
                    const exampleLine = item.example.trim()
                      ? item.example.split('\n')[0]?.trim() ?? ''
                      : ''
                    return (
                      <tr key={item.id} className="study-row" onClick={() => openDetailModal(item.id)}>
                        <td className="col-phrase">
                          <div className="list-phrase-line">
                            <strong className="list-phrase-main">{item.phrase}</strong>
                            <span className={`item-type-pill item-type-${itemType}`}>
                              {ITEM_TYPE_LABEL[itemType]}
                            </span>
                          </div>
                          {exampleLine && <div className="list-phrase-example">"{exampleLine}"</div>}
                          {phraseWords.length >= 2 && (
                            <div
                              className="list-phrase-words"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {phraseWords.map((word, index) => (
                                <button
                                  key={`${item.id}-${index}-${word}`}
                                  type="button"
                                  className="list-phrase-word"
                                  onClick={() => openCreateModalWithPhrase(word, item)}
                                >
                                  {word}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="col-meaning">
                          <span className="list-meaning-text">{koPrimary}</span>
                        </td>
                        <td className="col-source">
                          <span className="list-source-badge">
                            <span className="list-source-icon" aria-hidden>
                              🎬
                            </span>{' '}
                            {(item.show ?? '').trim() || '작품 미입력'}
                          </span>
                        </td>
                        <td className="col-tags">
                          <div className="list-tag-cell" onClick={(event) => event.stopPropagation()}>
                            {item.tags.length > 0 ? (
                              item.tags.map((tag) => (
                                <span key={tag} className="list-tag-pill">
                                  {tag}
                                </span>
                              ))
                            ) : (
                              <span className="list-tag-empty">—</span>
                            )}
                          </div>
                        </td>
                        <td className="col-status">
                          <span className={`list-status-pill list-status-${item.status}`}>
                            {STATUS_LABEL[item.status]}
                          </span>
                        </td>
                        <td className="col-stars">
                          <span
                            className="list-star-row"
                            aria-label={`난이도 ${item.difficulty}에 가까운 평점`}
                          >
                            {[1, 2, 3].map((n) => (
                              <span key={n} className={n <= item.difficulty ? 'star on' : 'star off'}>
                                ★
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="col-actions">
                          <div className="list-actions" onClick={(event) => event.stopPropagation()}>
                            <button
                              type="button"
                              className="list-icon-btn list-icon-edit"
                              title="수정"
                              onClick={() => openEditModal(item)}
                            >
                              ✏️
                            </button>
                            <button
                              type="button"
                              className="list-icon-btn list-icon-del"
                              title="삭제"
                              onClick={() => removeItem(item.id)}
                            >
                              🗑️
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {filteredItems.length === 0 && (
                <p className="list-empty">조건에 맞는 항목이 없습니다. 검색이나 필터를 바꿔 보세요.</p>
              )}
            </div>
          </>
        )}
        {page === 'board' && (
          <>
            <section className="item-type-filter-row">
              <button
                type="button"
                className={itemTypeFilter === 'all' ? 'active' : ''}
                onClick={() => setItemTypeFilter('all')}
              >
                Vocabulary+Expression+Idiom
              </button>
              <button
                type="button"
                className={itemTypeFilter === 'vocabulary' ? 'active' : ''}
                onClick={() => setItemTypeFilter('vocabulary')}
              >
                Vocabulary
              </button>
              <button
                type="button"
                className={itemTypeFilter === 'expression' ? 'active' : ''}
                onClick={() => setItemTypeFilter('expression')}
              >
                Expression
              </button>
              <button
                type="button"
                className={itemTypeFilter === 'idiom' ? 'active' : ''}
                onClick={() => setItemTypeFilter('idiom')}
              >
                Idiom
              </button>
            </section>
            <section className="board">
              {(['new', 'learning', 'mastered'] as Status[]).map((status) => {
              const columnItems = items.filter((item) => {
                const itemType = item.itemType ?? inferItemType(item.phrase)
                const passType = itemTypeFilter === 'all' ? true : itemType === itemTypeFilter
                return item.status === status && passType
              })
              return (
                <div
                  className={`column board-column ${boardDragOverStatus === status ? 'is-drop-target' : ''}`}
                  key={status}
                  onDragOver={(event) => onBoardColumnDragOver(event, status)}
                  onDragLeave={() => setBoardDragOverStatus(null)}
                  onDrop={(event) => onBoardColumnDrop(event, status)}
                >
                  <div className="board-column-head">
                    <span className={`board-dot board-dot--${status}`} aria-hidden />
                    <h3>{STATUS_LABEL[status]}</h3>
                    <span className="board-count">{boardColumnCounts[status]}</span>
                  </div>
                  {columnItems.length === 0 ? (
                    <p className="board-column-empty">이 칸에 카드가 없습니다.</p>
                  ) : (
                    columnItems.map((item) => {
                      const itemType = item.itemType ?? inferItemType(item.phrase)
                      const koPrimary =
                        splitTranslationParts(item.translation).primary || item.translation
                      const exampleLine = item.example.trim()
                        ? item.example.split('\n')[0]?.trim() ?? ''
                        : ''
                      return (
                        <article
                          key={item.id}
                          className={`board-card board-card--${itemType}`}
                          draggable
                          onDragStart={(event) => onBoardCardDragStart(event, item.id)}
                          onDragEnd={() => setBoardDragOverStatus(null)}
                        >
                          <button
                            type="button"
                            className="board-card-main plain-trigger"
                            onClick={() => openDetailModal(item.id)}
                          >
                            <div className="board-card-top">
                              <div className="board-title-line">
                                <strong className="board-phrase">{item.phrase}</strong>
                                <span className={`item-type-pill item-type-${itemType}`}>
                                  {ITEM_TYPE_LABEL[itemType]}
                                </span>
                              </div>
                              <span className="board-deck-pill" title={item.deck}>
                                {item.deck || '기본 덱'}
                              </span>
                            </div>
                            <p className="board-ko">{koPrimary}</p>
                            {item.tags.length > 0 && (
                              <div className="board-tags" aria-label="태그">
                                {item.tags.map((tag) => (
                                  <span key={tag} className="board-tag">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                            {exampleLine && (
                              <p className="board-example">
                                <span className="board-example-label">예문</span>
                                <span className="board-example-text">"{exampleLine}"</span>
                              </p>
                            )}
                            <div className="board-meta-row">
                              <span className="board-source">
                                <span className="board-source-icon" aria-hidden>
                                  🎬
                                </span>
                                {(item.show ?? '').trim() || '작품 미입력'}
                                {item.episode ? (
                                  <small className="board-ep">{item.episode}</small>
                                ) : null}
                              </span>
                              <span
                                className="board-stars"
                                aria-label={`중요도·난이도 ${item.difficulty}단계`}
                              >
                                {[1, 2, 3].map((n) => (
                                  <span
                                    key={n}
                                    className={n <= item.difficulty ? 'star on' : 'star off'}
                                  >
                                    ★
                                  </span>
                                ))}
                              </span>
                            </div>
                            <dl className="board-srs">
                              <div>
                                <dt>복습</dt>
                                <dd>{item.reviewCount}회</dd>
                              </div>
                              <div>
                                <dt>마지막</dt>
                                <dd>{dateText(item.lastReviewedAt)}</dd>
                              </div>
                              <div>
                                <dt>일정</dt>
                                <dd>{item.scheduledDate ? item.scheduledDate : '—'}</dd>
                              </div>
                            </dl>
                            {item.notes.trim() ? (
                              <p className="board-notes" title={item.notes}>
                                {item.notes}
                              </p>
                            ) : null}
                          </button>
                          <div className="card-actions board-card-actions">
                            {status !== 'new' && (
                              <button type="button" onClick={() => updateStatus(item.id, 'new')}>
                                ← 새 단어
                              </button>
                            )}
                            {status !== 'learning' && (
                              <button type="button" onClick={() => updateStatus(item.id, 'learning')}>
                                학습
                              </button>
                            )}
                            {status !== 'mastered' && (
                              <button type="button" onClick={() => updateStatus(item.id, 'mastered')}>
                                완료 →
                              </button>
                            )}
                          </div>
                        </article>
                      )
                    })
                  )}
                </div>
              )
              })}
            </section>
          </>
        )}

        {page === 'cards' && (
          <section className="cards-page">
            <section className="item-type-filter-row">
              <button
                type="button"
                className={itemTypeFilter === 'all' ? 'active' : ''}
                onClick={() => setItemTypeFilter('all')}
              >
                Vocabulary+Expression+Idiom
              </button>
              <button
                type="button"
                className={itemTypeFilter === 'vocabulary' ? 'active' : ''}
                onClick={() => setItemTypeFilter('vocabulary')}
              >
                Vocabulary
              </button>
              <button
                type="button"
                className={itemTypeFilter === 'expression' ? 'active' : ''}
                onClick={() => setItemTypeFilter('expression')}
              >
                Expression
              </button>
              <button
                type="button"
                className={itemTypeFilter === 'idiom' ? 'active' : ''}
                onClick={() => setItemTypeFilter('idiom')}
              >
                Idiom
              </button>
            </section>
            <p className="card-counter">
              {cardItems.length === 0
                ? '카드 없음'
                : `${cardIndex + 1} / ${cardItems.length} 카드 · ${currentCard?.deck ?? ''}`}
            </p>
            {currentCard ? (
              <>
                <div className="carousel-wrap">
                  <button className="carousel-nav left" onClick={prevCard}>
                    ◀
                  </button>
                  <div
                    className="card-stack"
                    onPointerDown={onCardSwipeStart}
                    onPointerUp={onCardSwipeEnd}
                    onPointerCancel={onCardSwipeEnd}
                  >
                    {[-2, -1, 0, 1, 2].map((offset) => {
                      const idx = cyclicIndex(cardIndex + offset, cardItems.length)
                      const stackCard = cardItems[idx]
                      if (!stackCard) return null
                      const isCenter = offset === 0
                      const itemType = stackCard.itemType ?? inferItemType(stackCard.phrase)
                      const isExampleRevealed = !isCenter || cardTimerProgress <= 0.5
                      const card = (
                        <button
                          type="button"
                          className={`flashcard flashcard--${itemType} stack-pos-${offset} ${isCenter && cardFlipped ? 'flipped' : ''}`}
                          onClick={() => {
                            if (suppressCardClickRef.current) return
                            if (isCenter) {
                              setCardFlipped((prev) => !prev)
                            } else {
                              const n = cardItems.length
                              const forward = (idx - cardIndex + n) % n
                              const backward = (cardIndex - idx + n) % n
                              setCardEnterDir(forward <= backward ? 'next' : 'prev')
                              setCardIndex(idx)
                              setCardFlipped(false)
                              setCardSlideTick((t) => t + 1)
                            }
                          }}
                        >
                          <div className="flashcard-inner">
                            <div className="flashcard-face flashcard-front">
                              <span>{isCenter ? '클릭해서 뜻 확인' : stackCard.deck}</span>
                              <div className="flashcard-title-line">
                                <h3>{stackCard.phrase}</h3>
                                <small className={`item-type-pill item-type-${itemType}`}>
                                  {ITEM_TYPE_LABEL[itemType]}
                                </small>
                              </div>
                              {stackCard.example && (
                                <p
                                  className={`flashcard-example ${isExampleRevealed ? 'is-revealed' : ''}`}
                                >
                                  "{stackCard.example}"
                                </p>
                              )}
                            </div>
                            <div className="flashcard-face flashcard-back">
                              <span>뜻</span>
                              {(() => {
                                const translationParts = splitTranslationParts(stackCard.translation)
                                const primaryMeaning = translationParts.primary || stackCard.translation
                                return (
                                  <>
                                    <h3>{primaryMeaning}</h3>
                                    {translationParts.secondary.length > 0 && (
                                      <p className="flashcard-secondary-meaning">
                                        {translationParts.secondary.join(' · ')}
                                      </p>
                                    )}
                                  </>
                                )
                              })()}
                              {stackCard.notes && <p>{stackCard.notes}</p>}
                            </div>
                          </div>
                        </button>
                      )
                      if (isCenter) {
                        return (
                          <div
                            key={stackCard.id}
                            className={`flashcard-motion flashcard-motion--${cardEnterDir}`}
                          >
                            {card}
                          </div>
                        )
                      }
                      return (
                        <div key={`${stackCard.id}-${offset}`} className="flashcard-slot">
                          {card}
                        </div>
                      )
                    })}
                  </div>
                  <button className="carousel-nav right" onClick={nextCard}>
                    ▶
                  </button>
                </div>
                <div className="card-timer-wrap">
                  <div className="card-timer-label">다음 카드까지</div>
                  <div className="card-timer-track" aria-hidden>
                    <div
                      className="card-timer-fill"
                      style={{
                        transform: `scaleX(${cardTimerProgress})`,
                      }}
                    />
                  </div>
                </div>
                <div className="rate-buttons">
                  <button className="again" onClick={() => rateCard('again')}>
                    다시
                  </button>
                  <button className="good" onClick={() => rateCard('good')}>
                    좋아요
                  </button>
                  <button className="easy" onClick={() => rateCard('easy')}>
                    쉬워요
                  </button>
                  <button className="skip" onClick={() => rateCard('skip')}>
                    건너뛰기
                  </button>
                </div>

                <section className="deck-grid-wrap">
                  <div className="deck-grid-title">덱 폴더</div>
                  <div className="deck-grid">
                    <button
                      className={`deck-folder ${activeDeck === 'all' ? 'active' : ''}`}
                      onClick={() => {
                        setActiveDeck('all')
                        setCardIndex(0)
                        setCardFlipped(false)
                        setCardSlideTick((t) => t + 1)
                      }}
                      onDoubleClick={() => {
                        setOpenedDeck('all')
                        setActiveDeck('all')
                        setCardIndex(0)
                        setCardFlipped(false)
                        setCardSlideTick((t) => t + 1)
                      }}
                    >
                      <div className="folder-icon">📁</div>
                      <strong>전체 덱</strong>
                      <small>{items.length} cards</small>
                    </button>
                    {deckNames.map((deck) => (
                      <button
                        key={deck}
                        className={`deck-folder ${activeDeck === deck ? 'active' : ''}`}
                        onClick={() => {
                          setActiveDeck(deck)
                          setCardIndex(0)
                          setCardFlipped(false)
                          setCardSlideTick((t) => t + 1)
                        }}
                        onDoubleClick={() => {
                          setOpenedDeck(deck)
                          setActiveDeck(deck)
                          setCardIndex(0)
                          setCardFlipped(false)
                          setCardSlideTick((t) => t + 1)
                        }}
                      >
                        <div className="folder-icon">📁</div>
                        <strong>{deck}</strong>
                        <small>{deckCountMap[deck] ?? 0} cards</small>
                      </button>
                    ))}
                  </div>
                </section>

                {openedDeck && (
                  <section className="deck-explorer">
                    <header className="deck-explorer-head">
                      <div>
                        <strong>📁 {openedDeck === 'all' ? '전체 덱' : openedDeck}</strong>
                        <small>{openedDeckItems.length} cards</small>
                      </div>
                      <div className="deck-explorer-actions">
                        <button
                          className="secondary"
                          onClick={() => openCreateModal(openedDeck === 'all' ? undefined : openedDeck)}
                        >
                          + 카드 추가
                        </button>
                        <button className="secondary" onClick={() => setOpenedDeck(null)}>
                          폴더 닫기
                        </button>
                      </div>
                    </header>
                    <div className="deck-file-list">
                      {openedDeckGroups.map((group) => (
                        <section key={group.deck} className="deck-group-section">
                          {openedDeck === 'all' && (
                            <div className="deck-group-title">
                              <strong>📂 {group.deck}</strong>
                              <small>{group.items.length} cards</small>
                            </div>
                          )}
                          {group.items.map((item) => (
                            <div key={item.id} className="deck-file-row">
                              <button className="deck-file-main" onClick={() => openDetailModal(item.id)}>
                                <strong>{item.phrase}</strong>
                                <small>{item.translation}</small>
                              </button>
                              <div className="deck-file-actions">
                                <button className="secondary" onClick={() => openEditModal(item)}>
                                  수정
                                </button>
                                <button className="danger" onClick={() => removeItemFromDeck(item.id)}>
                                  삭제
                                </button>
                              </div>
                            </div>
                          ))}
                        </section>
                      ))}
                      {openedDeckItems.length === 0 && (
                        <div className="deck-file-empty">폴더 안 카드가 없습니다. + 카드 추가를 눌러주세요.</div>
                      )}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <>
                <div className="empty">복습할 카드가 없습니다.</div>
                <section className="deck-grid-wrap">
                  <div className="deck-grid-title">덱 폴더</div>
                  <div className="deck-grid">
                    <button
                      className={`deck-folder ${activeDeck === 'all' ? 'active' : ''}`}
                      onClick={() => {
                        setActiveDeck('all')
                        setCardIndex(0)
                        setCardFlipped(false)
                        setCardSlideTick((t) => t + 1)
                      }}
                      onDoubleClick={() => {
                        setOpenedDeck('all')
                        setActiveDeck('all')
                        setCardIndex(0)
                        setCardFlipped(false)
                        setCardSlideTick((t) => t + 1)
                      }}
                    >
                      <div className="folder-icon">📁</div>
                      <strong>전체 덱</strong>
                      <small>{items.length} cards</small>
                    </button>
                    {deckNames.map((deck) => (
                      <button
                        key={deck}
                        className={`deck-folder ${activeDeck === deck ? 'active' : ''}`}
                        onClick={() => {
                          setActiveDeck(deck)
                          setCardIndex(0)
                          setCardFlipped(false)
                          setCardSlideTick((t) => t + 1)
                        }}
                        onDoubleClick={() => {
                          setOpenedDeck(deck)
                          setActiveDeck(deck)
                          setCardIndex(0)
                          setCardFlipped(false)
                          setCardSlideTick((t) => t + 1)
                        }}
                      >
                        <div className="folder-icon">📁</div>
                        <strong>{deck}</strong>
                        <small>{deckCountMap[deck] ?? 0} cards</small>
                      </button>
                    ))}
                  </div>
                </section>

                {openedDeck && (
                  <section className="deck-explorer">
                    <header className="deck-explorer-head">
                      <div>
                        <strong>📁 {openedDeck === 'all' ? '전체 덱' : openedDeck}</strong>
                        <small>{openedDeckItems.length} cards</small>
                      </div>
                      <div className="deck-explorer-actions">
                        <button
                          className="secondary"
                          onClick={() => openCreateModal(openedDeck === 'all' ? undefined : openedDeck)}
                        >
                          + 카드 추가
                        </button>
                        <button className="secondary" onClick={() => setOpenedDeck(null)}>
                          폴더 닫기
                        </button>
                      </div>
                    </header>
                    <div className="deck-file-list">
                      {openedDeckGroups.map((group) => (
                        <section key={group.deck} className="deck-group-section">
                          {openedDeck === 'all' && (
                            <div className="deck-group-title">
                              <strong>📂 {group.deck}</strong>
                              <small>{group.items.length} cards</small>
                            </div>
                          )}
                          {group.items.map((item) => (
                            <div key={item.id} className="deck-file-row">
                              <button className="deck-file-main" onClick={() => openDetailModal(item.id)}>
                                <strong>{item.phrase}</strong>
                                <small>{item.translation}</small>
                              </button>
                              <div className="deck-file-actions">
                                <button className="secondary" onClick={() => openEditModal(item)}>
                                  수정
                                </button>
                                <button className="danger" onClick={() => removeItemFromDeck(item.id)}>
                                  삭제
                                </button>
                              </div>
                            </div>
                          ))}
                        </section>
                      ))}
                      {openedDeckItems.length === 0 && (
                        <div className="deck-file-empty">폴더 안 카드가 없습니다. + 카드 추가를 눌러주세요.</div>
                      )}
                    </div>
                  </section>
                )}
              </>
            )}
          </section>
        )}

        {page === 'calendar' && (
          <section className="calendar-page">
            <div className="calendar-header">
              <h3>학습 캘린더</h3>
              <div className="calendar-nav">
                <button className="secondary" onClick={() => moveMonth(-1)}>
                  ←
                </button>
                <strong>{monthTitle(calendarMonth)}</strong>
                <button className="secondary" onClick={() => moveMonth(1)}>
                  →
                </button>
              </div>
            </div>

            <div className="calendar-layout">
              <aside className="unscheduled-panel">
                <h4>미배정 카드</h4>
                <p>카드를 원하는 날짜로 드래그하세요</p>
                <div
                  className="unscheduled-drop"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    const itemId = event.dataTransfer.getData('text/plain')
                    if (itemId) clearSchedule(itemId)
                  }}
                >
                  {unscheduledItems.map((item) => (
                    <div
                      key={item.id}
                      className="cal-card"
                      draggable
                      onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                      onClick={() => openDetailModal(item.id)}
                    >
                      <strong>{item.phrase}</strong>
                      <small>{item.translation}</small>
                    </div>
                  ))}
                  {unscheduledItems.length === 0 && <div className="cal-empty">미배정 카드 없음</div>}
                </div>
              </aside>

              <div className="calendar-grid-wrap">
                <div className="calendar-weekdays">
                  {['일', '월', '화', '수', '목', '금', '토'].map((day) => (
                    <div key={day}>{day}</div>
                  ))}
                </div>
                <div className="calendar-grid">
                  {calendarDays.map((day) => {
                    const key = toDateKey(day)
                    const inMonth = day.getMonth() === calendarMonth.getMonth()
                    const dayItems = itemsByDate[key] ?? []
                    return (
                      <div
                        key={key}
                        className={`calendar-cell ${inMonth ? '' : 'out-month'}`}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault()
                          const itemId = event.dataTransfer.getData('text/plain')
                          if (itemId) scheduleItem(itemId, key)
                        }}
                      >
                        <div className="cell-date">{day.getDate()}</div>
                        <div className="cell-cards">
                          {dayItems.map((item) => (
                            <div
                              key={item.id}
                              className="cal-card"
                              draggable
                              onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                              onClick={() => openDetailModal(item.id)}
                            >
                              <strong>{item.phrase}</strong>
                              <small>{item.show || '작품 미입력'}</small>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {createPortal(
        <nav className="mobile-bottom-nav" aria-label="모바일 주 메뉴">
          {NAV_ITEMS.map((item) => (
            <button
              key={`mobile-${item.id}`}
              type="button"
              className={page === item.id ? 'active' : ''}
              onClick={() => setPage(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>,
        document.body,
      )}

      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <section className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>계정 및 동기화 설정</h3>
              <button
                type="button"
                onClick={() => {
                  setIsSettingsOpen(false)
                  setSettingsMsg('')
                }}
              >
                ✕
              </button>
            </header>
            <div className="settings-tab-row">
              <button
                type="button"
                className={settingsTab === 'account' ? 'active' : ''}
                onClick={() => setSettingsTab('account')}
              >
                계정/동기화
              </button>
              <button
                type="button"
                className={settingsTab === 'profiles' ? 'active' : ''}
                onClick={() => setSettingsTab('profiles')}
              >
                카드 정보 프로파일
              </button>
            </div>
            {settingsTab === 'account' ? (
              <>
                <div className="settings-block">
                  <small>계정</small>
                  <strong>{authUser?.displayName || 'Google 사용자'}</strong>
                  <p>{authUser?.email || '이메일 없음'}</p>
                </div>
                <div className="settings-block">
                  <small>자동 생성 기본 모델</small>
                  <strong>{AI_PROVIDER_LABEL[appSettings.defaultAiProvider]}</strong>
                  <div className="ai-provider-row">
                    <select
                      value={appSettings.defaultAiProvider}
                      onChange={(event) => {
                        void updateDefaultAiProvider(event.target.value as AiProvider)
                      }}
                    >
                      <option value="default">{AI_PROVIDER_LABEL.default}</option>
                      <option value="gemini">{AI_PROVIDER_LABEL.gemini}</option>
                    </select>
                    <small>
                      {appSettings.defaultAiProvider === 'gemini' && !GEMINI_API_KEY
                        ? 'Gemini 키가 없으면 기본 엔진으로 자동 전환됩니다.'
                        : '카드 추가/수정에서 기본값으로 사용됩니다.'}
                    </small>
                  </div>
                </div>
                <div className="settings-actions">
                  <button type="button" className="secondary" onClick={forceSyncNow} disabled={!authUser}>
                    지금 동기화
                  </button>
                  <button type="button" className="secondary" onClick={exportItemsJson}>
                    데이터 내보내기
                  </button>
                  <button type="button" className="secondary" onClick={() => importFileRef.current?.click()}>
                    데이터 가져오기
                  </button>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept="application/json"
                    className="settings-hidden-file"
                    onChange={(event) => {
                      importItemsJson(event.target.files?.[0] ?? null)
                      event.currentTarget.value = ''
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="profile-settings-panel">
                <form className="profile-editor-form" onSubmit={submitProfileEditor}>
                  <label>
                    프로파일 이름 *
                    <input
                      value={profileEditor.name}
                      onChange={(event) =>
                        setProfileEditor((prev) => ({
                          ...prev,
                          name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="row2">
                    <label>
                      드라마 / 작품명
                      <input
                        list="show-keywords"
                        value={profileEditor.show}
                        onChange={(event) =>
                          setProfileEditor((prev) => ({
                            ...prev,
                            show: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      에피소드
                      <input
                        list="episode-keywords"
                        value={profileEditor.episode}
                        onChange={(event) =>
                          setProfileEditor((prev) => ({
                            ...prev,
                            episode: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="row2">
                    <label>
                      태그 (쉼표 구분)
                      <input
                        list="tag-keywords"
                        value={profileEditor.tags}
                        onChange={(event) =>
                          setProfileEditor((prev) => ({
                            ...prev,
                            tags: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      덱(그룹)
                      <input
                        list="deck-keywords"
                        value={profileEditor.deck}
                        onChange={(event) =>
                          setProfileEditor((prev) => ({
                            ...prev,
                            deck: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="row2">
                    <label>
                      난이도
                      <select
                        value={profileEditor.difficulty}
                        onChange={(event) =>
                          setProfileEditor((prev) => ({
                            ...prev,
                            difficulty: Number(event.target.value) as 1 | 2 | 3,
                          }))
                        }
                      >
                        <option value={1}>★ 쉬움</option>
                        <option value={2}>★★ 보통</option>
                        <option value={3}>★★★ 어려움</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    메모
                    <textarea
                      value={profileEditor.notes}
                      onChange={(event) =>
                        setProfileEditor((prev) => ({
                          ...prev,
                          notes: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="profile-editor-actions">
                    <button type="submit" className="secondary">
                      {profileEditor.id ? '프로파일 업데이트' : '새 프로파일 저장'}
                    </button>
                    <button type="button" className="secondary" onClick={resetProfileEditor}>
                      새로 작성
                    </button>
                  </div>
                </form>
                <div className="profile-list">
                  {profiles.length === 0 ? (
                    <p className="profile-list-empty">저장된 프로파일이 없습니다.</p>
                  ) : (
                    profiles.map((profile) => (
                      <div key={profile.id} className="profile-list-item">
                        <div>
                          <strong>{profile.name}</strong>
                          <p>
                            {profile.show || '작품 미입력'} · {profile.episode || '에피소드 미입력'} ·{' '}
                            {profile.deck}
                          </p>
                          <small>연결 카드 {profileUsageCounts[profile.id] ?? 0}개</small>
                        </div>
                        <div className="profile-list-actions">
                          <button type="button" className="secondary" onClick={() => startEditProfile(profile)}>
                            수정
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `"${profile.name}" 프로파일을 삭제할까요? 연결 카드들은 프로파일 연결만 해제됩니다.`,
                                )
                              ) {
                                void deleteProfile(profile.id)
                              }
                            }}
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {settingsMsg && <p className="settings-msg">{settingsMsg}</p>}
            {syncError && <p className="settings-error">{syncError}</p>}
            <footer>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setIsSettingsOpen(false)
                  setSettingsMsg('')
                }}
              >
                닫기
              </button>
            </footer>
          </section>
        </div>
      )}

      {isAddOpen && (
        <div className="modal-overlay" onClick={closeAddModal}>
          <section className="modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>단어 / 구문 추가</h3>
              <button onClick={closeAddModal}>✕</button>
            </header>
            <div className="tab-row">
              <button className={inputTab === 'text' ? 'active' : ''} onClick={() => setInputTab('text')}>
                직접 입력
              </button>
              <button className={inputTab === 'ocr' ? 'active' : ''} onClick={() => setInputTab('ocr')}>
                이미지 인식 (OCR)
              </button>
            </div>
            {inputTab === 'ocr' && (
              <div className="ocr-panel">
                <p className="ocr-hint">
                  이미지를 드래그해서 놓거나 클릭해서 파일을 선택하세요. 이 탭이 열린 상태에서 {' '}
                  <kbd>Ctrl</kbd>+<kbd>V</kbd>로 클립보드 이미지를 붙여넣을 수 있습니다.
                </p>
                <div
                  className={`ocr-dropzone ${ocrDragOver ? 'ocr-dropzone-active' : ''} ${ocrPreviewUrl ? 'ocr-dropzone-filled' : ''}`}
                  onClick={() => ocrFileInputRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setOcrDragOver(true)
                  }}
                  onDragLeave={() => setOcrDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setOcrDragOver(false)
                    const file = event.dataTransfer.files?.[0]
                    loadOcrImageFile(file)
                  }}
                >
                  <input
                    ref={ocrFileInputRef}
                    type="file"
                    accept="image/*"
                    className="ocr-file-input"
                    onChange={(event) => {
                      loadOcrImageFile(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                  {ocrPreviewUrl ? (
                    <img src={ocrPreviewUrl} alt="" className="ocr-preview-img" />
                  ) : (
                    <span className="ocr-dropzone-label">여기에 놓거나 클릭해서 업로드</span>
                  )}
                </div>
                <div className="ocr-toolbar">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!ocrPreviewUrl || isOcrRunning}
                    onClick={(event) => {
                      event.stopPropagation()
                      void runOcrRecognize()
                    }}
                  >
                    {isOcrRunning ? `텍스트 인식 중… ${ocrProgress}%` : '텍스트 인식 (OCR)'}
                  </button>
                  {ocrPreviewUrl && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={isOcrRunning}
                      onClick={(event) => {
                        event.stopPropagation()
                        resetOcrState()
                      }}
                    >
                      이미지 지우기
                    </button>
                  )}
                </div>
                {ocrError && <div className="ocr-error">{ocrError}</div>}
                {ocrLines.length > 0 && (
                  <div className="ocr-results">
                    <p className="ocr-results-title">인식된 줄 — 영어 구문으로 쓸 줄을 체크하세요.</p>
                    <ul className="ocr-line-list">
                      {ocrLines.map((line, index) => (
                        <li key={`${index}-${line.slice(0, 24)}`} className="ocr-line-row">
                          <label className="ocr-line-label">
                            <input
                              type="checkbox"
                              checked={ocrLineSelected.includes(index)}
                              onChange={() => toggleOcrLine(index)}
                            />
                            <span className="ocr-line-text">{line}</span>
                          </label>
                          <button
                            type="button"
                            className="secondary ocr-line-apply"
                            onClick={() => setForm((prev) => ({ ...prev, phrase: line }))}
                          >
                            이 줄만 적용
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="ocr-result-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={ocrLineSelected.length === 0}
                        onClick={applyOcrSelectionToPhrase}
                      >
                        선택한 줄을 영어 구문에 적용
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            phrase: ocrLines.join(' ').replace(/\s+/g, ' ').trim(),
                          }))
                        }
                      >
                        전체 텍스트 적용
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <form onSubmit={onSubmitAdd} className="modal-form">
              <label>
                영어 단어 / 구문 *
                <div className="af-input-row">
                  <input
                    value={form.phrase}
                    onChange={(event) => setForm((prev) => ({ ...prev, phrase: event.target.value }))}
                  />
                  <select
                    className="ai-provider-inline"
                    value={formAiProvider}
                    onChange={(event) => setFormAiProvider(event.target.value as AiProvider)}
                  >
                    <option value="default">기본</option>
                    <option value="gemini">Gemini</option>
                  </select>
                  <button
                    type="button"
                    className="secondary af-btn-inline"
                    onClick={() => autoFillFromEnglish(Boolean(editingId), formAiProvider)}
                    disabled={isAutoFilling}
                  >
                    {isAutoFilling ? (editingId ? '업데이트 중...' : '생성 중...') : editingId ? '업데이트' : '자동 생성'}
                  </button>
                </div>
                <small className="af-msg">
                  모델: {AI_PROVIDER_LABEL[formAiProvider]}
                  {formAiProvider === 'gemini' && !GEMINI_API_KEY ? ' (API 키 필요)' : ''} · 유형 자동 판별:{' '}
                  {ITEM_TYPE_LABEL[inferItemTypeAuto(form.phrase)]}
                </small>
                {autoFillMsg && <small className="af-msg">{autoFillMsg}</small>}
              </label>
              <label>
                한국어 뜻 *
                <textarea
                  className="translation-box"
                  rows={4}
                  value={form.translation}
                  onChange={(event) => setForm((prev) => ({ ...prev, translation: event.target.value }))}
                />
              </label>
              <label>
                예문
                <textarea
                  rows={4}
                  value={form.example}
                  onChange={(event) => setForm((prev) => ({ ...prev, example: event.target.value }))}
                />
              </label>
              <div className="profile-bind-row">
                <label>
                  카드 정보 프로파일
                  <select value={form.profileId} onChange={(event) => onFormProfileChange(event.target.value)}>
                    <option value="">직접 입력 (프로파일 미사용)</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="profile-bind-actions">
                  <button type="button" className="secondary" onClick={saveProfileFromCurrentForm}>
                    현재 입력으로 프로파일 저장
                  </button>
                  {isFormUsingProfile && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setForm((prev) => ({ ...prev, profileId: '' }))
                      }}
                    >
                      프로파일 해제
                    </button>
                  )}
                </div>
                {selectedFormProfile && (
                  <p className="profile-bind-hint">
                    "{selectedFormProfile.name}" 프로파일을 사용하는 중입니다. 메타 정보는 프로파일 변경 시
                    연결된 카드에 일괄 반영됩니다.
                  </p>
                )}
              </div>
              <div className="row2">
                <label>
                  드라마 / 작품명
                  <input
                    list="show-keywords"
                    value={form.show}
                    onChange={(event) => setForm((prev) => ({ ...prev, show: event.target.value }))}
                    disabled={isFormUsingProfile}
                  />
                </label>
                <label>
                  에피소드
                  <input
                    list="episode-keywords"
                    value={form.episode}
                    onChange={(event) => setForm((prev) => ({ ...prev, episode: event.target.value }))}
                    disabled={isFormUsingProfile}
                  />
                </label>
              </div>
              <div className="row2">
                <label>
                  태그 (쉼표 구분)
                  <input
                    list="tag-keywords"
                    value={form.tags}
                    onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
                    disabled={isFormUsingProfile}
                  />
                </label>
                <label>
                  덱(그룹)
                  <input
                    list="deck-keywords"
                    value={form.deck}
                    onChange={(event) => setForm((prev) => ({ ...prev, deck: event.target.value }))}
                    placeholder="예: 일상 회화, 비즈니스, 시험"
                    disabled={isFormUsingProfile}
                  />
                </label>
              </div>
              <div className="row2">
                <label>
                  난이도
                  <select
                    value={form.difficulty}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        difficulty: Number(event.target.value) as 1 | 2 | 3,
                      }))
                    }
                    disabled={isFormUsingProfile}
                  >
                    <option value={1}>★ 쉬움</option>
                    <option value={2}>★★ 보통</option>
                    <option value={3}>★★★ 어려움</option>
                  </select>
                </label>
              </div>
              <label>
                메모
                <textarea
                  value={form.notes}
                  onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                  disabled={isFormUsingProfile}
                />
              </label>
              <footer>
                <button type="button" className="secondary" onClick={closeAddModal}>
                  취소
                </button>
                <button type="submit" className="primary">
                  저장하기
                </button>
              </footer>
            </form>
            <datalist id="show-keywords">
              {showKeywords.map((keyword) => (
                <option key={`show-${keyword}`} value={keyword} />
              ))}
            </datalist>
            <datalist id="episode-keywords">
              {episodeKeywords.map((keyword) => (
                <option key={`episode-${keyword}`} value={keyword} />
              ))}
            </datalist>
            <datalist id="deck-keywords">
              {deckKeywords.map((keyword) => (
                <option key={`deck-${keyword}`} value={keyword} />
              ))}
            </datalist>
            <datalist id="tag-keywords">
              {tagKeywords.map((keyword) => (
                <option key={`tag-${keyword}`} value={keyword} />
              ))}
            </datalist>
          </section>
        </div>
      )}

      {isDetailOpen && detailItem && (
        <div className="modal-overlay" onClick={() => setIsDetailOpen(false)}>
          <section className="modal detail" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>상세 보기</h3>
              <button onClick={() => setIsDetailOpen(false)}>✕</button>
            </header>
            <h2>{detailItem.phrase}</h2>
            <p className="det-trans">{detailTranslation.primary || detailItem.translation}</p>
            {detailTranslation.secondary.length > 0 && (
              <div className="det-trans-sub">
                {detailTranslation.secondary.map((line) => (
                  <div key={line}>- {line}</div>
                ))}
              </div>
            )}
            {detailItem.example && <div className="det-box">"{detailItem.example}"</div>}
            <div className="chips">
              <span>{ITEM_TYPE_LABEL[detailItem.itemType ?? inferItemType(detailItem.phrase)]}</span>
              <span>{STATUS_LABEL[detailItem.status]}</span>
              <span>{detailItem.show || '작품 미입력'}</span>
              <span>{detailItem.deck}</span>
              <span>{'★'.repeat(detailItem.difficulty)}</span>
              {detailItem.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            {detailItem.notes && <div className="det-box">{detailItem.notes}</div>}
            <div className="meta-grid">
              <div>
                <strong>{detailItem.reviewCount}</strong>
                <small>복습 횟수</small>
              </div>
              <div>
                <strong>{dateText(detailItem.lastReviewedAt)}</strong>
                <small>마지막 복습</small>
              </div>
              <div>
                <strong>{dateText(detailItem.createdAt)}</strong>
                <small>추가일</small>
              </div>
            </div>
            <div className="status-actions">
              <button onClick={() => updateStatus(detailItem.id, 'new')}>→ 새 단어</button>
              <button onClick={() => updateStatus(detailItem.id, 'learning')}>→ 학습 중</button>
              <button onClick={() => updateStatus(detailItem.id, 'mastered')}>→ 완료</button>
            </div>
            {detailPhraseWords.length >= 2 && (
              <div className="det-phrase-words">
                <p className="det-phrase-words-label">포함된 단어 — 클릭하면 새 카드로 추가합니다</p>
                <div className="det-phrase-words-btns">
                  {detailPhraseWords.map((word, index) => (
                    <button
                      key={`${index}-${word}`}
                      type="button"
                      className="det-phrase-word-btn"
                      onClick={() => openCreateModalWithPhrase(word, detailItem)}
                    >
                      {word}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <footer>
              <button className="secondary" onClick={() => openEditModal(detailItem)}>
                수정
              </button>
              <button className="danger" onClick={() => removeItem(detailItem.id)}>
                삭제
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
