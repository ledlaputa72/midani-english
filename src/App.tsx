import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Status = 'new' | 'learning' | 'mastered'
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
}

const STORAGE_KEY = 'midani.study.items.v2'

/** 플래시카드 자동 넘김 간격 (롤링 배너, ms) */
const CARD_AUTO_ADVANCE_MS = 8000

const STATUS_LABEL: Record<Status, string> = {
  new: '새 단어',
  learning: '학습 중',
  mastered: '완료',
}

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

function loadItems(): StudyItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return SAMPLE_ITEMS
    const parsed = JSON.parse(raw) as StudyItem[]
    if (!Array.isArray(parsed) || parsed.length === 0) return SAMPLE_ITEMS
    return parsed.map((item) => ({
      ...item,
      deck: item.deck?.trim() || '기본 덱',
    }))
  } catch {
    return SAMPLE_ITEMS
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
  }
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

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [items, setItems] = useState<StudyItem[]>(() => loadItems())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all')
  const [listShowFilter, setListShowFilter] = useState<string>('all')
  const [listSort, setListSort] = useState<ListSort>('latest')

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [inputTab, setInputTab] = useState<InputTab>('text')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
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
  const [weekStart, setWeekStart] = useState(() => {
    const today = new Date()
    const day = today.getDay()
    const diff = day === 0 ? -6 : 1 - day
    return addDays(today, diff)
  })

  const persist = (next: StudyItem[]) => {
    setItems(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
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
      if (statusFilter !== 'all' && item.status !== statusFilter) return false
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
  }, [items, query, statusFilter, listShowFilter, listSort])

  const stats = useMemo(
    () => ({
      total: items.length,
      learning: items.filter((item) => item.status === 'learning').length,
      mastered: items.filter((item) => item.status === 'mastered').length,
      shows: new Set(items.map((item) => item.show).filter(Boolean)).size,
    }),
    [items],
  )

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
      return passDeck && passLearning
    })
  }, [items, activeDeck])

  const currentCard = cardItems[cardIndex] ?? null
  const detailItem = detailId ? items.find((item) => item.id === detailId) ?? null : null
  const detailTranslation = splitTranslationParts(detailItem?.translation ?? '')
  const detailPhraseWords = useMemo(
    () => splitPhraseWords(detailItem?.phrase ?? ''),
    [detailItem?.phrase],
  )

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

  useEffect(() => {
    if (activeDeck === 'all') return
    if (!deckNames.includes(activeDeck)) {
      setActiveDeck('all')
      setCardIndex(0)
      setCardFlipped(false)
    }
  }, [activeDeck, deckNames])

  useEffect(() => {
    if (!openedDeck) return
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
    setForm({ ...EMPTY_FORM, deck: deckPreset || EMPTY_FORM.deck })
    setInputTab('text')
    setIsAddOpen(true)
  }

  const openCreateModalWithPhrase = (phrase: string, deckPreset?: string) => {
    const deck = (deckPreset ?? EMPTY_FORM.deck).trim() || EMPTY_FORM.deck
    resetOcrState()
    setEditingId(null)
    setForm({ ...EMPTY_FORM, phrase: phrase.trim(), deck })
    setInputTab('text')
    setIsDetailOpen(false)
    setIsAddOpen(true)
  }

  const openEditModal = (item: StudyItem) => {
    resetOcrState()
    setEditingId(item.id)
    setForm(toFormState(item))
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

  const openedDeckItems = useMemo(() => {
    if (!openedDeck) return []
    return items.filter((item) => item.deck === openedDeck)
  }, [items, openedDeck])

  const onSubmitAdd = (event: FormEvent) => {
    event.preventDefault()
    if (!form.phrase.trim() || !form.translation.trim()) return

    const payload = {
      phrase: form.phrase.trim(),
      translation: form.translation.trim(),
      example: form.example.trim(),
      show: form.show.trim(),
      episode: form.episode.trim(),
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      difficulty: form.difficulty,
      notes: form.notes.trim(),
      deck: form.deck.trim() || '기본 덱',
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

  const autoFillFromEnglish = async () => {
    const phrase = form.phrase.trim()
    if (!phrase || isAutoFilling) return

    setIsAutoFilling(true)
    setAutoFillMsg('자동 생성 중...')

    let koMeaning = ''
    let enExample = ''
    let koExample = ''
    let altMeanings: string[] = []

    try {
      const transRes = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(phrase)}&langpair=en|ko`,
      )
      if (transRes.ok) {
        const transData = (await transRes.json()) as {
          responseData?: { translatedText?: string }
          matches?: Array<{ translation?: string }>
        }
        koMeaning = sanitizeTranslationApiText(transData.responseData?.translatedText?.trim() || '')
        altMeanings = (transData.matches ?? [])
          .map((m) => sanitizeTranslationApiText(m.translation?.trim() || ''))
          .filter((line) => line && line !== koMeaning)
          .slice(0, 2)
      }
    } catch {
      // Ignore translation API failures and fallback below.
    }

    try {
      const keyword = phrase.split(/\s+/)[0]?.replace(/[^a-zA-Z'-]/g, '')
      if (keyword) {
        const dictRes = await fetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(keyword)}`,
        )
        if (dictRes.ok) {
          const dictData = (await dictRes.json()) as Array<{
            meanings?: Array<{ definitions?: Array<{ example?: string }> }>
          }>
          const examples: string[] = []
          for (const entry of dictData) {
            for (const meaning of entry.meanings ?? []) {
              for (const def of meaning.definitions ?? []) {
                if (def.example) examples.push(def.example)
              }
            }
          }
          enExample =
            examples.find((line) => line.toLowerCase().includes(phrase.toLowerCase())) ||
            examples[0] ||
            ''
        }
      }
    } catch {
      // Ignore dictionary API failures and fallback below.
    }

    if (!koMeaning) {
      koMeaning = `"${phrase}"의 의미를 확인해 주세요.`
    }
    if (!enExample) {
      enExample = `People often say "${phrase}" in everyday conversation.`
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
      translation: prev.translation.trim() ? prev.translation : translationText,
      example: prev.example.trim() ? prev.example : exampleText,
    }))

    setAutoFillMsg('뜻/예문 자동 채우기를 완료했습니다.')
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <h1>Mid/Ani English</h1>
          <p>미드/애니 영어 학습</p>
        </div>
        <nav>
          <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>
            대시보드
          </button>
          <button className={page === 'list' ? 'active' : ''} onClick={() => setPage('list')}>
            리스트
          </button>
          <button className={page === 'board' ? 'active' : ''} onClick={() => setPage('board')}>
            보드
          </button>
          <button className={page === 'cards' ? 'active' : ''} onClick={() => setPage('cards')}>
            플래시카드
          </button>
          <button className={page === 'calendar' ? 'active' : ''} onClick={() => setPage('calendar')}>
            캘린더
          </button>
        </nav>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <h2>{page === 'list' ? '📋 전체 목록' : '학습 노트'}</h2>
            <p>
              {page === 'list'
                ? '단어·구문·뜻을 한눈에 보고 복습해 보세요.'
                : '프로토타입 기반 모달 + 카드 학습 흐름'}
            </p>
          </div>
          <button className="primary" onClick={() => openCreateModal()}>
            {page === 'list' ? '+ 추가' : '단어 / 구문 추가'}
          </button>
        </header>

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
                <span>단어 · 구문</span>
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
                  <h4>🔔 오늘의 복습</h4>
                  <p>복습할 단어가 {dashboardDue.length}개 있어요!</p>
                </div>
                <button className="primary" onClick={() => setPage('cards')}>
                  지금 복습하기 →
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
                    const exampleLine = item.example.trim()
                      ? item.example.split('\n')[0]?.trim() ?? ''
                      : ''
                    return (
                      <tr key={item.id} className="study-row" onClick={() => openDetailModal(item.id)}>
                        <td className="col-phrase">
                          <strong className="list-phrase-main">{item.phrase}</strong>
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
                                  onClick={() => openCreateModalWithPhrase(word, item.deck)}
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
          <section className="board">
            {(['new', 'learning', 'mastered'] as Status[]).map((status) => (
              <div className="column" key={status}>
                <h3>{STATUS_LABEL[status]}</h3>
                {items
                  .filter((item) => item.status === status)
                  .map((item) => (
                    <article key={item.id} className="board-card">
                      <button className="plain-trigger" onClick={() => openDetailModal(item.id)}>
                        <strong>{item.phrase}</strong>
                        <p>{item.translation}</p>
                      </button>
                      <div className="card-actions">
                        {status !== 'new' && (
                          <button onClick={() => updateStatus(item.id, 'new')}>새 단어</button>
                        )}
                        {status !== 'learning' && (
                          <button onClick={() => updateStatus(item.id, 'learning')}>학습 중</button>
                        )}
                        {status !== 'mastered' && (
                          <button onClick={() => updateStatus(item.id, 'mastered')}>완료</button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            ))}
          </section>
        )}

        {page === 'cards' && (
          <section className="cards-page">
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
                  <div className="card-stack">
                    {[-2, -1, 0, 1, 2].map((offset) => {
                      const idx = cyclicIndex(cardIndex + offset, cardItems.length)
                      const stackCard = cardItems[idx]
                      if (!stackCard) return null
                      const isCenter = offset === 0
                      const card = (
                        <button
                          type="button"
                          className={`flashcard stack-pos-${offset} ${isCenter && cardFlipped ? 'flipped' : ''}`}
                          onClick={() => {
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
                              <h3>{stackCard.phrase}</h3>
                              {stackCard.example && <p>"{stackCard.example}"</p>}
                            </div>
                            <div className="flashcard-face flashcard-back">
                              <span>뜻</span>
                              <h3>{stackCard.translation}</h3>
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
                      onDoubleClick={() => setOpenedDeck(null)}
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
                        <strong>📁 {openedDeck}</strong>
                        <small>{openedDeckItems.length} cards</small>
                      </div>
                      <div className="deck-explorer-actions">
                        <button className="secondary" onClick={() => openCreateModal(openedDeck)}>
                          + 카드 추가
                        </button>
                        <button className="secondary" onClick={() => setOpenedDeck(null)}>
                          폴더 닫기
                        </button>
                      </div>
                    </header>
                    <div className="deck-file-list">
                      {openedDeckItems.map((item) => (
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
                      onDoubleClick={() => setOpenedDeck(null)}
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
                        <strong>📁 {openedDeck}</strong>
                        <small>{openedDeckItems.length} cards</small>
                      </div>
                      <div className="deck-explorer-actions">
                        <button className="secondary" onClick={() => openCreateModal(openedDeck)}>
                          + 카드 추가
                        </button>
                        <button className="secondary" onClick={() => setOpenedDeck(null)}>
                          폴더 닫기
                        </button>
                      </div>
                    </header>
                    <div className="deck-file-list">
                      {openedDeckItems.map((item) => (
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
                  <button type="button" className="secondary af-btn-inline" onClick={autoFillFromEnglish} disabled={isAutoFilling}>
                    {isAutoFilling ? '생성 중...' : '자동 생성'}
                  </button>
                </div>
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
              <div className="row2">
                <label>
                  드라마 / 작품명
                  <input
                    value={form.show}
                    onChange={(event) => setForm((prev) => ({ ...prev, show: event.target.value }))}
                  />
                </label>
                <label>
                  에피소드
                  <input
                    value={form.episode}
                    onChange={(event) => setForm((prev) => ({ ...prev, episode: event.target.value }))}
                  />
                </label>
              </div>
              <div className="row2">
                <label>
                  태그 (쉼표 구분)
                  <input
                    value={form.tags}
                    onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
                  />
                </label>
                <label>
                  덱(그룹)
                  <input
                    value={form.deck}
                    onChange={(event) => setForm((prev) => ({ ...prev, deck: event.target.value }))}
                    placeholder="예: 일상 회화, 비즈니스, 시험"
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
                      onClick={() => openCreateModalWithPhrase(word, detailItem.deck)}
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
