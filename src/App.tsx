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
const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()

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
      return inferItemTypeAuto((item as StudyItem).phrase ?? '', '')
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

/**
 * example 필드를 파싱해 [뜻] 블록 배열로 변환합니다.
 * 새 형식: "[뜻]\n📝 설명\nA:...\nB:...\n→ A:...\nB:..." 블록이 \n\n으로 구분됨
 * 구형식: 헤더 없는 단일 예문 텍스트
 */
function parseMeaningBlocks(
  example: string,
  primary: string,
  alts: string[],
): MeaningBlock[] {
  const trimmed = example.trim()
  if (!trimmed) return []

  const hasHeaders = /\n{2,}/.test(trimmed) || /^\[.+\]/.test(trimmed)

  if (hasHeaders) {
    const rawBlocks = trimmed.split(/\n{2,}/)
    const blocks: MeaningBlock[] = []
    for (const raw of rawBlocks) {
      const lines = raw.split('\n')
      let meaning = ''
      let description = ''
      const dialogueLines: string[] = []
      for (const line of lines) {
        const t = line.trim()
        if (/^\[.+\]$/.test(t)) {
          meaning = t.slice(1, -1).trim()
        } else if (t.startsWith('📝')) {
          description = t.slice(2).trim()
        } else if (t) {
          dialogueLines.push(line)
        }
      }
      const dialogue = dialogueLines.join('\n').trim()
      if (meaning || dialogue) blocks.push({ meaning, description, dialogue })
    }
    return blocks
  }

  // 구형식: 첫 번째 뜻을 레이블로 사용
  const allMeanings = [primary, ...alts].filter(Boolean)
  return [{ meaning: allMeanings[0] ?? '', description: '', dialogue: trimmed }]
}

/**
 * 예문 텍스트에서 학습 구문을 찾아 <strong> 볼드로 강조합니다.
 * - 대소문자 무시
 * - 괄호 선택 표기가 있는 경우 (예: "catch up (on)") base/full 형태 모두 강조
 * - 영어 부분만 강조 (→ 이후 한국어 번역 라인은 매칭 안 됨)
 */
function highlightPhrase(text: string, phrase: string): React.ReactNode {
  if (!phrase.trim() || !text.trim()) return text

  const parsed = parseOptionalPhrase(phrase)
  // 더 긴 형태부터 매칭 (full → base 순서, 겹침 방지)
  const forms = parsed.hasOptional
    ? [parsed.full, parsed.base]
    : [phrase.trim()]

  const escapedForms = forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escapedForms.join('|')})`, 'gi')

  // "→" 이후는 한국어 번역 → 강조 제외
  const arrowIdx = text.indexOf('\n→')
  const enPart = arrowIdx !== -1 ? text.slice(0, arrowIdx) : text
  const koPart = arrowIdx !== -1 ? text.slice(arrowIdx) : ''

  const parts = enPart.split(regex)
  const nodes: React.ReactNode[] = parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="highlight-phrase">
        {part}
      </strong>
    ) : (
      part
    ),
  )

  return (
    <>
      {nodes}
      {koPart}
    </>
  )
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
  const p = phrase.trim()
  const templates = [
    `A: Have you heard that expression "${p}"?\nB: Yeah, it's a common phrase — let me use it in a sentence.`,
    `A: What does "${p}" mean exactly?\nB: It's used to express a specific idea — context matters a lot.`,
    `A: Can you give me an example using "${p}"?\nB: Sure — it often comes up in everyday conversation.`,
    `A: Is "${p}" formal or informal?\nB: It depends on the situation, but it's quite commonly used.`,
  ]
  return deterministicPick(templates, p)
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
    normalized.includes('try saying "') ||
    normalized.includes('have you heard that expression') ||
    normalized.includes('what does "') ||
    normalized.includes('can you give me an example') ||
    normalized.includes('is "') ||
    normalized.includes('the points have been allocated') ||
    normalized.includes('let me use it in a sentence') ||
    normalized.includes('[의미') ||
    normalized.includes('[meaning')
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

type GeminiExample = {
  meaning: string       // 어떤 뜻의 예문인지
  description?: string  // 이 뜻의 사용 맥락 설명 (Korean)
  en: string            // 영어 예문
  ko: string            // 한국어 번역
}

type MeaningBlock = {
  meaning: string
  description: string  // when/how to use this meaning
  dialogue: string     // dialogue example (may be empty)
}

type GeminiAutofillResult = {
  meaningKo: string
  altMeaningsKo: string[]
  exampleEn: string
  exampleKo?: string
  examples?: GeminiExample[]   // 뜻별 예문 배열 (신규)
  definitionHint?: string
  itemType?: ItemType
}

const PHRASE_USAGE_OVERRIDES: Record<
  string,
  { meaningKo: string; altMeaningsKo?: string[]; exampleEn: string; exampleKo: string; itemType?: ItemType }
> = {
  // ── A ──────────────────────────────────────────────────────────────
  'add insult to injury': {
    meaningKo: '설상가상으로 더 나쁘게 만들다.',
    altMeaningsKo: ['엎친 데 덮친 격이다.'],
    exampleEn: "A: He didn't even apologize.\nB: And then he blamed me — talk about adding insult to injury.",
    exampleKo: 'A: 그는 사과조차 하지 않았어.\nB: 게다가 나를 탓하기까지 했어 — 정말 엎친 데 덮친 격이지.',
    itemType: 'idiom',
  },
  'at the drop of a hat': {
    meaningKo: '즉시, 망설임 없이.',
    altMeaningsKo: ['언제든 바로'],
    exampleEn: "A: Can you come help me move?\nB: Of course — I'd do it at the drop of a hat.",
    exampleKo: 'A: 이사 도와줄 수 있어?\nB: 물론이지 — 언제든 바로 달려갈게.',
    itemType: 'idiom',
  },
  // ── B ──────────────────────────────────────────────────────────────
  'back to square one': {
    meaningKo: '처음으로 돌아가다.',
    altMeaningsKo: ['원점으로 돌아가다.'],
    exampleEn: "A: The plan failed completely.\nB: I know. We're back to square one.",
    exampleKo: 'A: 계획이 완전히 실패했어.\nB: 맞아. 원점으로 돌아간 거야.',
    itemType: 'idiom',
  },
  'beat around the bush': {
    meaningKo: '핵심을 피하고 빙빙 돌려 말하다.',
    altMeaningsKo: ['돌려서 말하다.', '핵심을 회피하다.'],
    exampleEn: "A: Just tell me what's wrong.\nB: Stop beating around the bush and be direct.",
    exampleKo: 'A: 뭐가 문제인지 그냥 말해줘.\nB: 빙빙 돌리지 말고 직접적으로 말해.',
    itemType: 'idiom',
  },
  'bite the bullet': {
    meaningKo: '이를 악물고 참다, 힘든 상황을 감수하다.',
    altMeaningsKo: ['어려움을 견디다.'],
    exampleEn: "A: The dentist appointment is going to hurt.\nB: I know, but I'll just have to bite the bullet.",
    exampleKo: 'A: 치과 예약이 아플 거야.\nB: 알아, 그냥 이를 악물고 견뎌야지.',
    itemType: 'idiom',
  },
  'bite the dust': {
    meaningKo: '실패하다, 쓰러지다.',
    altMeaningsKo: ['망하다.', '죽다.'],
    exampleEn: "A: Did the startup survive?\nB: No, it bit the dust after just six months.",
    exampleKo: 'A: 그 스타트업 살아남았어?\nB: 아니, 6개월 만에 망했어.',
    itemType: 'idiom',
  },
  'born yesterday': {
    meaningKo: '세상 물정 모르는, 순진하게 속다.',
    altMeaningsKo: ['그렇게 쉽게 속지 않아.', '나 바보 아니야.'],
    exampleEn: "A: He thought I'd believe that story?\nB: Does he think I was born yesterday?",
    exampleKo: 'A: 그가 내가 그 얘기를 믿을 거라 생각했대?\nB: 나를 뭘로 보는 거야, 내가 그렇게 순진한 줄 알아?',
    itemType: 'idiom',
  },
  "i wasn't born yesterday": {
    meaningKo: '나 그렇게 순진하지 않아. 나 호락호락하지 않아.',
    altMeaningsKo: ['그런 걸로 못 속여.', '나 바보 아니거든.'],
    exampleEn: "A: I think this plan is fair.\nB: I wasn't born yesterday. Let's double-check the details.",
    exampleKo: 'A: 이 계획은 공정한 것 같아.\nB: 나 호락호락하지 않아. 세부 사항을 다시 확인해 보자.',
    itemType: 'idiom',
  },
  'break the ice': {
    meaningKo: '어색한 분위기를 깨다.',
    altMeaningsKo: ['첫 대화를 시작하다.'],
    exampleEn: "A: The room was so quiet at the party.\nB: Yeah, someone needed to break the ice.",
    exampleKo: 'A: 파티에서 방이 너무 조용했어.\nB: 맞아, 누군가 어색한 분위기를 깨야 했어.',
    itemType: 'idiom',
  },
  'burn bridges': {
    meaningKo: '관계를 완전히 끊다, 돌아올 수 없게 만들다.',
    altMeaningsKo: ['퇴로를 차단하다.'],
    exampleEn: "A: Should I quit without notice?\nB: Don't burn bridges — give proper notice.",
    exampleKo: 'A: 예고 없이 그냥 그만둘까?\nB: 관계를 끊지 마 — 제대로 예고를 해.',
    itemType: 'idiom',
  },
  // ── C ──────────────────────────────────────────────────────────────
  'call it a day': {
    meaningKo: '오늘은 여기서 끝내다, 일을 마치다.',
    altMeaningsKo: ['그만하다.', '마무리하다.'],
    exampleEn: "A: We've been working for eight hours.\nB: Let's call it a day and get some rest.",
    exampleKo: 'A: 8시간이나 일했어.\nB: 오늘은 여기서 끝내고 쉬자.',
    itemType: 'idiom',
  },
  'cold feet': {
    meaningKo: '(막판에) 겁이 나서 포기하고 싶은 마음.',
    altMeaningsKo: ['긴장해서 망설이다.'],
    exampleEn: "A: Are you still going through with the wedding?\nB: I'm getting cold feet, honestly.",
    exampleKo: 'A: 결혼 그대로 진행하는 거야?\nB: 솔직히 겁이 나서 망설여져.',
    itemType: 'idiom',
  },
  'cold shoulder': {
    meaningKo: '냉대하다, 무시하다.',
    altMeaningsKo: ['쌀쌀맞게 대하다.'],
    exampleEn: "A: Why isn't she talking to you?\nB: She's been giving me the cold shoulder all week.",
    exampleKo: 'A: 왜 그녀가 너한테 말 안 해?\nB: 일주일 내내 나를 냉대하고 있어.',
    itemType: 'idiom',
  },
  'cost an arm and a leg': {
    meaningKo: '엄청나게 비싸다.',
    altMeaningsKo: ['큰돈이 들다.'],
    exampleEn: "A: Did you buy the new phone?\nB: No, it costs an arm and a leg.",
    exampleKo: 'A: 새 폰 샀어?\nB: 아니, 너무 비싸.',
    itemType: 'idiom',
  },
  'cut it out': {
    meaningKo: '그만해.',
    altMeaningsKo: ['집어치워.', '그만 좀 해.'],
    exampleEn: 'A: Why are you making fun of him?\nB: Okay, okay. Cut it out. I got it.',
    exampleKo: 'A: 왜 그를 놀리는 거야?\nB: 알았어, 알았어. 그만할게.',
    itemType: 'idiom',
  },
  // ── D ──────────────────────────────────────────────────────────────
  'down to earth': {
    meaningKo: '현실적이고 소탈한, 꾸밈없는.',
    altMeaningsKo: ['겸손하고 현실적인.'],
    exampleEn: "A: Is the new manager approachable?\nB: Very — she's really down to earth.",
    exampleKo: 'A: 새 매니저는 다가가기 쉬워?\nB: 응 — 정말 소탈하고 현실적이야.',
    itemType: 'idiom',
  },
  'drop the ball': {
    meaningKo: '실수하다, 책임을 다하지 못하다.',
    altMeaningsKo: ['중요한 것을 놓치다.'],
    exampleEn: "A: Who forgot to send the report?\nB: I dropped the ball on that. I'm sorry.",
    exampleKo: 'A: 누가 보고서 보내는 거 잊었어?\nB: 내가 실수했어. 미안해.',
    itemType: 'idiom',
  },
  // ── E ──────────────────────────────────────────────────────────────
  'easier said than done': {
    meaningKo: '말하기는 쉽지만 실제로 하기는 어렵다.',
    altMeaningsKo: ['말이야 쉽지.'],
    exampleEn: "A: Just forget about it and move on.\nB: Easier said than done.",
    exampleKo: 'A: 그냥 잊고 앞으로 나아가.\nB: 말이야 쉽지.',
    itemType: 'idiom',
  },
  // ── F ──────────────────────────────────────────────────────────────
  'face the music': {
    meaningKo: '결과에 책임지다, 현실을 직면하다.',
    altMeaningsKo: ['책임을 지다.'],
    exampleEn: "A: You made a mistake. What now?\nB: I have to face the music and apologize.",
    exampleKo: 'A: 네가 실수했어. 이제 어쩔 거야?\nB: 현실을 직면하고 사과해야지.',
    itemType: 'idiom',
  },
  'from scratch': {
    meaningKo: '처음부터, 아무것도 없이 시작하다.',
    altMeaningsKo: ['맨 처음부터 시작하다.'],
    exampleEn: "A: Did you use a recipe?\nB: No, I made the whole dish from scratch.",
    exampleKo: 'A: 레시피 사용했어?\nB: 아니, 처음부터 직접 만들었어.',
    itemType: 'idiom',
  },
  // ── G ──────────────────────────────────────────────────────────────
  'get out of hand': {
    meaningKo: '통제를 벗어나다, 걷잡을 수 없게 되다.',
    altMeaningsKo: ['감당이 안 되다.'],
    exampleEn: "A: The argument got really intense.\nB: Yeah, it totally got out of hand.",
    exampleKo: 'A: 말다툼이 정말 심해졌어.\nB: 맞아, 완전히 걷잡을 수 없게 됐어.',
    itemType: 'idiom',
  },
  'get the hang of': {
    meaningKo: '요령을 익히다, 감을 잡다.',
    altMeaningsKo: ['익숙해지다.'],
    exampleEn: "A: Is the new software confusing?\nB: A little, but I'm starting to get the hang of it.",
    exampleKo: 'A: 새 소프트웨어 헷갈려?\nB: 조금, 근데 이제 감을 잡아가고 있어.',
    itemType: 'idiom',
  },
  'give the cold shoulder': {
    meaningKo: '냉대하다, 무시하다.',
    altMeaningsKo: ['쌀쌀맞게 굴다.'],
    exampleEn: "A: She didn't say a word to me.\nB: She's really giving you the cold shoulder.",
    exampleKo: 'A: 그녀가 나한테 한마디도 안 했어.\nB: 정말 너를 냉대하고 있네.',
    itemType: 'idiom',
  },
  // ── H ──────────────────────────────────────────────────────────────
  'hit the nail on the head': {
    meaningKo: '정확히 핵심을 짚다.',
    altMeaningsKo: ['딱 맞는 말을 하다.'],
    exampleEn: "A: I think the problem is a lack of communication.\nB: You hit the nail on the head.",
    exampleKo: 'A: 문제가 소통 부족인 것 같아.\nB: 정확히 핵심을 짚었어.',
    itemType: 'idiom',
  },
  'hit the sack': {
    meaningKo: '자다, 잠자리에 들다.',
    altMeaningsKo: ['자러 가다.'],
    exampleEn: "A: It's already midnight.\nB: I know, I'm going to hit the sack soon.",
    exampleKo: 'A: 벌써 자정이야.\nB: 알아, 곧 자러 갈 거야.',
    itemType: 'idiom',
  },
  'hold your horses': {
    meaningKo: '잠깐 기다려, 서두르지 마.',
    altMeaningsKo: ['진정해.', '천천히 해.'],
    exampleEn: "A: Let's just sign the contract now!\nB: Hold your horses — read the fine print first.",
    exampleKo: 'A: 지금 바로 계약서에 서명하자!\nB: 잠깐만 — 먼저 세부 조항을 읽어봐.',
    itemType: 'idiom',
  },
  // ── I ──────────────────────────────────────────────────────────────
  'in a nutshell': {
    meaningKo: '간단히 말하자면, 요약하면.',
    altMeaningsKo: ['한마디로.'],
    exampleEn: "A: Can you explain the situation?\nB: In a nutshell, we ran out of budget.",
    exampleKo: 'A: 상황을 설명해 줄 수 있어?\nB: 간단히 말하자면, 예산이 바닥났어.',
    itemType: 'idiom',
  },
  'in the same boat': {
    meaningKo: '같은 처지에 있다, 같은 상황이다.',
    altMeaningsKo: ['같은 배를 타고 있다.'],
    exampleEn: "A: I'm stressed about the deadline too.\nB: We're all in the same boat.",
    exampleKo: 'A: 나도 마감 때문에 스트레스받아.\nB: 우리 모두 같은 처지야.',
    itemType: 'idiom',
  },
  // ── J ──────────────────────────────────────────────────────────────
  'jump the gun': {
    meaningKo: '너무 성급하게 행동하다.',
    altMeaningsKo: ['섣불리 행동하다.'],
    exampleEn: "A: Did you already send the announcement?\nB: Maybe I jumped the gun — we didn't confirm yet.",
    exampleKo: 'A: 벌써 공지 보냈어?\nB: 성급했나 봐 — 아직 확인이 안 됐는데.',
    itemType: 'idiom',
  },
  // ── K ──────────────────────────────────────────────────────────────
  'kick the bucket': {
    meaningKo: '죽다.',
    altMeaningsKo: ['세상을 떠나다.'],
    exampleEn: "A: Whatever happened to that old car?\nB: It finally kicked the bucket last winter.",
    exampleKo: 'A: 그 낡은 차 어떻게 됐어?\nB: 지난 겨울에 드디어 수명이 다했어.',
    itemType: 'idiom',
  },
  // ── L ──────────────────────────────────────────────────────────────
  'let the cat out of the bag': {
    meaningKo: '비밀을 누설하다.',
    altMeaningsKo: ['비밀을 털어놓다.'],
    exampleEn: "A: Does she know about the surprise party?\nB: Tom let the cat out of the bag by accident.",
    exampleKo: 'A: 그녀가 깜짝 파티에 대해 알아?\nB: Tom이 실수로 비밀을 누설했어.',
    itemType: 'idiom',
  },
  'long story short': {
    meaningKo: '간단히 말하자면, 결론을 말하자면.',
    altMeaningsKo: ['요약하자면.'],
    exampleEn: "A: What happened at the meeting?\nB: Long story short, the project got canceled.",
    exampleKo: 'A: 회의에서 무슨 일이 있었어?\nB: 간단히 말하자면, 프로젝트가 취소됐어.',
    itemType: 'idiom',
  },
  // ── M ──────────────────────────────────────────────────────────────
  'miss the boat': {
    meaningKo: '기회를 놓치다.',
    altMeaningsKo: ['때를 놓치다.'],
    exampleEn: "A: Did you apply for that scholarship?\nB: No, I missed the boat — the deadline was yesterday.",
    exampleKo: 'A: 그 장학금 신청했어?\nB: 아니, 기회를 놓쳤어 — 마감이 어제였거든.',
    itemType: 'idiom',
  },
  // ── N ──────────────────────────────────────────────────────────────
  'nip it in the bud': {
    meaningKo: '초기에 싹을 자르다, 문제가 커지기 전에 해결하다.',
    altMeaningsKo: ['미리 막다.'],
    exampleEn: "A: The rumor is starting to spread.\nB: We need to nip it in the bud before it gets worse.",
    exampleKo: 'A: 소문이 퍼지기 시작했어.\nB: 더 나빠지기 전에 초기에 잘라야 해.',
    itemType: 'idiom',
  },
  // ── O ──────────────────────────────────────────────────────────────
  'on the fence': {
    meaningKo: '어느 쪽도 결정하지 못한, 망설이는.',
    altMeaningsKo: ['중립적인.', '결정을 못 하는.'],
    exampleEn: "A: Are you going to take the job offer?\nB: I'm still on the fence about it.",
    exampleKo: 'A: 그 일자리 제안 받아들일 거야?\nB: 아직 결정을 못 하고 있어.',
    itemType: 'idiom',
  },
  'on the same page': {
    meaningKo: '같은 생각이다, 서로 이해하고 있다.',
    altMeaningsKo: ['의견이 일치하다.'],
    exampleEn: "A: Do we all agree on the plan?\nB: Let's make sure everyone is on the same page.",
    exampleKo: 'A: 계획에 모두 동의해?\nB: 모두가 같은 생각인지 확인하자.',
    itemType: 'idiom',
  },
  'once in a blue moon': {
    meaningKo: '아주 가끔, 드물게.',
    altMeaningsKo: ['매우 드물게.'],
    exampleEn: "A: Do you ever eat fast food?\nB: Once in a blue moon, maybe.",
    exampleKo: 'A: 패스트푸드 먹어?\nB: 아주 가끔은 먹지.',
    itemType: 'idiom',
  },
  'out of the blue': {
    meaningKo: '갑자기, 예고 없이.',
    altMeaningsKo: ['뜬금없이.'],
    exampleEn: "A: He called me out of the blue after years.\nB: Wow, that must have been a surprise.",
    exampleKo: 'A: 그가 몇 년 만에 갑자기 전화했어.\nB: 와, 많이 놀랐겠다.',
    itemType: 'idiom',
  },
  // ── P ──────────────────────────────────────────────────────────────
  'pass the buck': {
    meaningKo: '책임을 남에게 떠넘기다.',
    altMeaningsKo: ['책임 회피하다.'],
    exampleEn: "A: Who's responsible for this error?\nB: Everyone keeps passing the buck to someone else.",
    exampleKo: 'A: 이 실수는 누구 책임이야?\nB: 다들 계속 남에게 책임을 떠넘기고 있어.',
    itemType: 'idiom',
  },
  'piece of cake': {
    meaningKo: '아주 쉬운 일.',
    altMeaningsKo: ['식은 죽 먹기.'],
    exampleEn: "A: Was the exam hard?\nB: Not at all — it was a piece of cake.",
    exampleKo: 'A: 시험 어려웠어?\nB: 전혀 — 식은 죽 먹기였어.',
    itemType: 'idiom',
  },
  'pull someone leg': {
    meaningKo: '놀리다, 농담으로 속이다.',
    altMeaningsKo: ['장난치다.'],
    exampleEn: "A: Did you really win the lottery?\nB: Ha, I'm just pulling your leg.",
    exampleKo: 'A: 진짜 복권에 당첨됐어?\nB: 하, 그냥 놀리는 거야.',
    itemType: 'idiom',
  },
  "pulling your leg": {
    meaningKo: '놀리다, 농담으로 속이다.',
    altMeaningsKo: ['장난치는 것이다.'],
    exampleEn: "A: Are you serious right now?\nB: Relax, I'm just pulling your leg.",
    exampleKo: 'A: 지금 진지한 거야?\nB: 진정해, 그냥 놀리는 거야.',
    itemType: 'idiom',
  },
  // ── R ──────────────────────────────────────────────────────────────
  'rain check': {
    meaningKo: '다음 기회로 미루다.',
    altMeaningsKo: ['나중에 하기로 하다.'],
    exampleEn: "A: Want to grab lunch today?\nB: I can't right now — can I take a rain check?",
    exampleKo: 'A: 오늘 점심 먹을래?\nB: 지금은 안 되는데 — 다음에 하면 안 될까?',
    itemType: 'idiom',
  },
  'read between the lines': {
    meaningKo: '행간을 읽다, 숨겨진 의미를 파악하다.',
    altMeaningsKo: ['말 속에 숨은 뜻을 읽다.'],
    exampleEn: "A: He said everything was fine, but...\nB: You have to read between the lines with him.",
    exampleKo: 'A: 그는 다 괜찮다고 했는데...\nB: 그 사람 말 속의 의미를 읽어야 해.',
    itemType: 'idiom',
  },
  'rock the boat': {
    meaningKo: '(현재 상태를) 흔들다, 문제를 일으키다.',
    altMeaningsKo: ['분란을 일으키다.'],
    exampleEn: "A: Should I bring up the salary issue?\nB: Be careful — nobody wants to rock the boat.",
    exampleKo: 'A: 급여 문제를 꺼내야 할까?\nB: 조심해 — 아무도 분란을 일으키고 싶어 하지 않아.',
    itemType: 'idiom',
  },
  // ── S ──────────────────────────────────────────────────────────────
  'see eye to eye': {
    meaningKo: '의견이 일치하다, 생각이 같다.',
    altMeaningsKo: ['동의하다.'],
    exampleEn: "A: Do you two agree on the plan?\nB: Not really — we never seem to see eye to eye.",
    exampleKo: 'A: 둘이 계획에 동의해?\nB: 별로 — 우린 항상 의견이 엇갈려.',
    itemType: 'idiom',
  },
  'silver lining': {
    meaningKo: '불행 중 다행, 나쁜 상황에서 찾는 긍정적인 면.',
    altMeaningsKo: ['위기 속의 기회.'],
    exampleEn: "A: Losing that job was hard.\nB: True, but the silver lining is you found a better one.",
    exampleKo: 'A: 그 직장을 잃은 건 힘들었어.\nB: 맞아, 하지만 불행 중 다행으로 더 좋은 곳을 찾았잖아.',
    itemType: 'idiom',
  },
  'spill the beans': {
    meaningKo: '비밀을 누설하다.',
    altMeaningsKo: ['털어놓다.'],
    exampleEn: "A: Who told her about the plan?\nB: Jake spilled the beans by accident.",
    exampleKo: 'A: 누가 그녀에게 계획을 말했어?\nB: Jake가 실수로 비밀을 누설했어.',
    itemType: 'idiom',
  },
  // ── T ──────────────────────────────────────────────────────────────
  'that ship has sailed': {
    meaningKo: '이미 때가 지났다, 기회를 놓쳤다.',
    altMeaningsKo: ['기회가 이미 지나갔다.'],
    exampleEn: "A: Maybe we can still fix things with them.\nB: I'm afraid that ship has sailed.",
    exampleKo: 'A: 아직 그들과 관계를 고칠 수 있을 것 같아.\nB: 유감이지만 이미 때가 지난 것 같아.',
    itemType: 'idiom',
  },
  'throw in the towel': {
    meaningKo: '포기하다, 항복하다.',
    altMeaningsKo: ['손을 들다.'],
    exampleEn: "A: The project keeps failing.\nB: I don't want to throw in the towel just yet.",
    exampleKo: 'A: 프로젝트가 계속 실패하고 있어.\nB: 아직 포기하고 싶지 않아.',
    itemType: 'idiom',
  },
  'tip of the iceberg': {
    meaningKo: '빙산의 일각, 문제의 일부만 보이는 것.',
    altMeaningsKo: ['드러난 것은 일부일 뿐이다.'],
    exampleEn: "A: There are so many hidden problems here.\nB: What we know is just the tip of the iceberg.",
    exampleKo: 'A: 여기에 숨겨진 문제가 너무 많아.\nB: 우리가 아는 건 빙산의 일각에 불과해.',
    itemType: 'idiom',
  },
  'under the weather': {
    meaningKo: '몸이 안 좋다, 컨디션이 나쁘다.',
    altMeaningsKo: ['몸이 좋지 않은.'],
    exampleEn: "A: You look pale today.\nB: Yeah, I'm feeling a little under the weather.",
    exampleKo: 'A: 오늘 안색이 안 좋아 보여.\nB: 응, 몸이 좀 안 좋아.',
    itemType: 'idiom',
  },
  // ── U / W ──────────────────────────────────────────────────────────
  'up in the air': {
    meaningKo: '아직 결정되지 않은, 불확실한.',
    altMeaningsKo: ['미정인.'],
    exampleEn: "A: Is the trip still happening?\nB: It's still up in the air — we haven't confirmed yet.",
    exampleKo: 'A: 여행 아직 진행돼?\nB: 아직 미정이야 — 아직 확인이 안 됐어.',
    itemType: 'idiom',
  },
  'writing on the wall': {
    meaningKo: '(나쁜 일이 올 것이라는) 조짐, 전조.',
    altMeaningsKo: ['불길한 징조.'],
    exampleEn: "A: Did you see the layoffs coming?\nB: The writing was on the wall for months.",
    exampleKo: 'A: 해고 사태가 올 것을 예상했어?\nB: 몇 달 전부터 조짐이 보였어.',
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

  // 괄호(선택 표기) 파싱
  const parsedPhrase = parseOptionalPhrase(phrase)

  // 선택적 부분이 있는 경우 프롬프트에 추가 지시 삽입
  const optionalNotes = parsedPhrase.hasOptional
    ? [
        `IMPORTANT: The notation "${phrase}" means the word/words in parentheses "(${parsedPhrase.optional})" are OPTIONAL.`,
        `This phrase has TWO valid forms:`,
        `  Form A (base): "${parsedPhrase.base}" — used without "${parsedPhrase.optional}"`,
        `  Form B (full): "${parsedPhrase.full}" — used with "${parsedPhrase.optional}"`,
        `DO NOT write "(${parsedPhrase.optional})" in any example sentence. Use only Form A or Form B as real English words.`,
        `- meaningKo: explain the meaning of BOTH forms and clearly state when each is used.`,
        `- altMeaningsKo: include entries for both "${parsedPhrase.base}" usage and "${parsedPhrase.full}" usage.`,
        `- In the examples array, provide one dialogue that uses Form A ("${parsedPhrase.base}") and one that uses Form B ("${parsedPhrase.full}").`,
      ]
    : []

  const allMeaningsNote = itemType !== 'vocabulary'
    ? 'Include ALL meaningful usage variants in altMeaningsKo (no limit — include every distinct meaning).'
    : ''

  const prompt = [
    'You are an English learning assistant for Korean learners.',
    `Target text: "${phrase}"`,
    `Item type: ${typeLabel}`,
    ...optionalNotes,
    allMeaningsNote,
    '',
    'Return ONLY a valid JSON object. No markdown, no explanation — just the raw JSON.',
    'Required JSON keys:',
    '{',
    '  "meaningKo": string,          // main Korean meaning',
    '  "altMeaningsKo": string[],    // ALL other Korean meanings/usages (no limit)',
    '  "definitionHint": string,     // brief English definition',
    '  "examples": [                 // one entry per meaning (meaningKo + each altMeaningKo)',
    '    {',
    '      "meaning": string,        // the Korean meaning this example illustrates',
    '      "en": string,             // English example (2-line A:/B: dialogue for expression/idiom)',
    '      "ko": string              // Korean translation of the dialogue',
    '    }',
    '  ],',
    '  "itemType": "vocabulary"|"expression"|"idiom"',
    '}',
    '',
    'Rules:',
    '- examples array MUST have one object for each meaning: 1 for meaningKo + 1 for EACH item in altMeaningsKo.',
    '- Each example object now has a "description" field: a 1-2 sentence Korean explanation of when/how to use this meaning.',
    '- For expression/idiom: each "en" must be a 2-line dialogue ("A: ...\\nB: ..."), "ko" translates both lines.',
    '- For vocabulary: each "en" is a single natural sentence.',
    '- DO NOT use markdown formatting (**bold**, *italic*, `code`) anywhere inside JSON string values.',
    '- DO NOT write parenthetical notation like "(on)" or "(to)" inside en/ko fields — use the actual word.',
    '- Prioritize natural/idiomatic meaning (NOT literal translation) for expression/idiom.',
  ].filter(Boolean).join('\n')

  try {
    // Vercel 서버리스 함수를 통해 호출 (CORS/보안 문제 해결)
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    if (!res.ok) {
      const errData = (await res.json().catch(() => ({}))) as { error?: string }
      return { result: null, error: errData.error ?? `http-${res.status}` }
    }
    const data = (await res.json()) as { text?: string; error?: string }
    if (data.error) return { result: null, error: data.error }

    const rawText = data.text ?? ''
    const jsonText = extractFirstJsonObject(rawText)
    if (!jsonText) return { result: null, error: 'invalid-json' }

    const parsed = JSON.parse(jsonText) as Partial<GeminiAutofillResult> & {
      examples?: Array<{ meaning?: unknown; en?: unknown; ko?: unknown }>
    }
    const meaningKo = normalizeKoreanMeaningLine(String(parsed.meaningKo ?? ''))
    const altMeaningsKo = Array.isArray(parsed.altMeaningsKo)
      ? parsed.altMeaningsKo
          .map((line) => normalizeKoreanMeaningLine(String(line)))
          .filter(Boolean)
      : []
    // Gemini 응답 텍스트 정리: 마크다운 제거 + 괄호 표기 잔재 제거
    const cleanGeminiText = (s: string): string =>
      s
        .replace(/\*\*([^*]+)\*\*/g, '$1')   // **bold** → bold
        .replace(/\*([^*]+)\*/g, '$1')         // *italic* → italic
        .replace(/`([^`]+)`/g, '$1')           // `code` → code
        .replace(/\s*\([^)]{1,20}\)/g, '')     // (on) (to) 같은 괄호 표기 제거
        .replace(/\s{2,}/g, ' ')
        .trim()

    // examples 배열 파싱 (뜻별 예문)
    const examples: GeminiExample[] = Array.isArray(parsed.examples)
      ? parsed.examples
          .filter((ex) => ex && typeof ex.en === 'string' && ex.en.trim())
          .map((ex) => ({
            meaning: cleanGeminiText(String(ex.meaning ?? '')).trim(),
            description: cleanGeminiText(String((ex as Record<string, unknown>).description ?? '')).trim(),
            en: cleanGeminiText(toSentenceCase(String(ex.en ?? '').trim())),
            ko: cleanGeminiText(normalizeKoreanMeaningLine(String(ex.ko ?? ''))),
          }))
          .filter((ex) => ex.en)
      : []

    // 하위 호환: examples가 없거나 비어있으면 exampleEn/exampleKo 사용
    const legacyEn = cleanGeminiText(toSentenceCase(String(parsed.exampleEn ?? '').trim()))
    const legacyKo = cleanGeminiText(normalizeKoreanMeaningLine(String(parsed.exampleKo ?? '')))
    const exampleEn = examples.length > 0 ? examples[0].en : legacyEn
    const exampleKo = examples.length > 0 ? examples[0].ko : legacyKo

    const definitionHint = String(parsed.definitionHint ?? '').trim()
    const parsedItemType =
      parsed.itemType === 'vocabulary' || parsed.itemType === 'expression' || parsed.itemType === 'idiom'
        ? parsed.itemType
        : undefined
    if (!meaningKo || !exampleEn) return { result: null, error: 'empty-fields' }
    return { result: { meaningKo, altMeaningsKo, exampleEn, exampleKo, examples, definitionHint, itemType: parsedItemType } }
  } catch (err) {
    return { result: null, error: err instanceof Error ? err.message.slice(0, 60) : 'fetch-failed' }
  }
}

/**
 * 구문이 이디엄일 가능성이 높은 패턴 목록.
 * 자주 쓰이는 영어 이디엄을 중심으로 구성.
 */
const IDIOM_PATTERNS: ReadonlyArray<RegExp> = [
  // ── 대표 이디엄 직접 매칭 ──────────────────────────────────────────
  /born yesterday/i,
  /cold (feet|shoulder|turkey|snap)\b/i,
  /rain check/i,
  /raining cats/i,
  /blue moon/i,
  /over the moon/i,
  /under the weather/i,
  /piece of cake/i,
  /beat around the bush/i,
  /silver lining/i,
  /throw in the towel/i,
  /barking up the wrong tree/i,
  /red.?handed/i,
  /kill two birds/i,
  /read between the lines/i,
  /pull (someone'?s?|my|your|their|his|her|one'?s?) leg\b/i,
  /burn (bridges|midnight oil|your boats?)/i,
  /face the music/i,
  /back to (the drawing board|square one)/i,
  /cut (corners|the mustard)\b/i,
  /cut it out\b/i,
  /cut to the chase/i,
  /miss(ed)? the boat/i,
  /ship has sailed/i,
  /pass the buck/i,
  /on the fence/i,
  /turn a blind eye/i,
  /foot in (my|your|their|his|her|the|one'?s?) mouth/i,
  /tie the knot/i,
  /speak of the devil/i,
  /drop the ball/i,
  /jump the gun/i,
  /get the hang of/i,
  /roll with the punches/i,
  /get the ball rolling/i,
  /from scratch/i,
  /down to earth/i,
  /nip (it )?in the bud/i,
  /icing on the cake/i,
  /see eye to eye/i,
  /on thin ice/i,
  /out of the blue/i,
  /call it a day/i,
  /hit it off\b/i,
  /hit the ground running/i,
  /out of hand/i,
  /make ends meet/i,
  /elephant in the room/i,
  /throw (someone )?under the bus/i,
  /nick of time/i,
  /grain of salt/i,
  /can of worms/i,
  /dime a dozen/i,
  /in a nutshell/i,
  /tip of the iceberg/i,
  /pay through the nose/i,
  /drop of a hat/i,
  /hold (your|my|his|her|their) horses/i,
  /easier said than done/i,
  /actions speak louder/i,
  /writing on the wall/i,
  /up in the air/i,
  /under (my|your|his|her|their|someone'?s?) thumb/i,
  /wrap (my|your|their|his|her|one'?s?) (head|mind) around/i,
  /on the same page/i,
  /bite (my|your|his|her|their|one'?s?) tongue/i,
  /cat got (your|my|their|his|her) tongue/i,
  /bone to pick/i,
  /off (my|your|his|her|their|one'?s?) chest/i,
  /wash (my|your|his|her|their|one'?s?) hands of/i,
  /fingers crossed/i,
  /add insult to injury/i,
  /last straw/i,
  /turn the other cheek/i,
  /on the bandwagon/i,
  /rock the boat/i,
  /own medicine/i,
  /pick up the slack/i,
  /get cold feet/i,
  /rock bottom/i,
  /raise the bar/i,
  /steal (the show|(someone'?s?|my|your|their|his|her) thunder)/i,
  /two cents/i,
  /bite off more than/i,
  /speak volumes/i,
  /in the same boat/i,
  /forest for the trees/i,
  /under the gun/i,
  /cup of tea/i,
  /arm and a leg/i,
  /long story short/i,
  /horse'?s? mouth/i,
  /ring(s)? a bell/i,
  /low.?hanging fruit/i,
  /bull by the horns/i,
  /sleeping dogs (lie|lay)/i,
  /spilled? milk/i,
  /out of steam/i,
  /benefit of the doubt/i,
  /hit a nerve/i,
  /under (my|your|his|her|their|one'?s?|someone'?s?) skin/i,
  /sore thumb/i,
  /devil'?s? advocate/i,
  /let (your|my|his|her|their) hair down/i,
  /get under (my|your|his|her|their|someone'?s?) skin/i,
  /in the same boat/i,
  /bite the hand that feeds/i,
  /at bay/i,
  /blood is thicker/i,
  /judge a book by its cover/i,
  // ── Verb + "the" 구조 (kick/bite/hit/spill + the + 명사) ──────────
  /\b(kick|bite|spill|face|beat|steal|drop|throw|burn|pass) the\b/i,
  /\bhit the (sack|road|hay|nail|ceiling|wall|spot|jackpot|books|gym)\b/i,
  /\bbreak (the ice|a leg|new ground|the bank|the mold)\b/i,
  /\blet the cat\b/i,
  /\bcat out of the bag\b/i,
]

/**
 * 괄호로 표시된 선택적 부분이 있는 구문을 파싱합니다.
 * 예) "catch up (on)" → { base: "catch up", optional: "on", full: "catch up on", hasOptional: true }
 * 예) "give up"       → { base: "give up",  optional: "",   full: "give up",    hasOptional: false }
 */
function parseOptionalPhrase(phrase: string): {
  base: string
  optional: string
  full: string
  hasOptional: boolean
} {
  const match = phrase.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  if (match) {
    const base = match[1].trim()
    const optional = match[2].trim()
    return { base, optional, full: `${base} ${optional}`, hasOptional: true }
  }
  return { base: phrase.trim(), optional: '', full: phrase.trim(), hasOptional: false }
}

function isLikelyIdiom(lower: string): boolean {
  // 괄호 선택 표기가 있으면 base form과 full form 모두 검사
  const { base, full } = parseOptionalPhrase(lower)
  return IDIOM_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(full))
}

function inferItemTypeAuto(phrase: string, definitionHint = ''): ItemType {
  const trimmed = phrase.trim()
  if (!trimmed) return 'vocabulary'
  // 괄호 제거 후 공백 체크 (예: "(something)" 단독은 vocabulary)
  const { base } = parseOptionalPhrase(trimmed)
  if (!/\s/.test(base) && !trimmed.includes('(')) return 'vocabulary'
  const lower = trimmed.toLowerCase()
  const hint = definitionHint.toLowerCase()
  // 1순위: definitionHint 키워드
  if (/\b(idiom|idiomatic|figurative|slang|colloquial)\b/.test(hint)) return 'idiom'
  // 2순위: 구문 자체가 이디엄 패턴에 매칭
  if (isLikelyIdiom(lower)) return 'idiom'
  // 그 외 다단어 구문 → expression
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
  const [openMeaningIdx, setOpenMeaningIdx] = useState<number>(0)
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
  const detailProfile = detailItem?.profileId ? profileMap.get(detailItem.profileId) ?? null : null
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
      itemType: inferItemTypeAuto(phrase.trim(), ''),
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
    setOpenMeaningIdx(0)
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
      itemType: form.itemType,
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
      // 뜻별 예문 배열이 있으면 멀티 예문 텍스트로 변환
      if (geminiResult.examples && geminiResult.examples.length > 0) {
        const allMeanings = [koMeaning, ...altMeanings]
        const examplesFormatted = geminiResult.examples
          .map((ex, i) => {
            const label = ex.meaning || allMeanings[i] || ''
            const header = label ? `[${label}]` : ''
            const descLine = ex.description ? `📝 ${ex.description}` : ''
            const body = ex.ko ? `${ex.en}\n→ ${ex.ko}` : ex.en
            const parts = [header, descLine, body].filter(Boolean)
            return parts.join('\n')
          })
          .join('\n\n')
        if (examplesFormatted) {
          enExample = examplesFormatted
          koExample = '' // 이미 위에서 인라인으로 포함됨
        }
      }
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
      // 이디엄으로 판별됐으나 override도 없고 Gemini도 실패한 경우
      // 사전 직역 대신 의미 확인 안내 메시지로 대체
      if (resolvedItemType === 'idiom' && !phraseOverride && koMeaning) {
        koMeaning = `"${phrase}"의 관용적 의미를 확인해 주세요.\n\n참고: 이 구문은 이디엄으로 직역과 다른 의미를 가질 수 있습니다.`
        altMeanings = []
      }
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

    // 멀티 예문(Gemini examples 사용)이 아닐 때만 MyMemory 번역 호출
    const isMultiExample = enExample.includes('\n\n') || enExample.startsWith('[')
    if (!isMultiExample) {
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
    }

    const meaningLines = [koMeaning, ...altMeanings].filter(Boolean)
    const translationText =
      meaningLines.length === 1
        ? meaningLines[0]
        : `${meaningLines[0]}\n\n대체 표현:\n- ${meaningLines.slice(1).join('\n- ')}`

    const exampleText = isMultiExample
      ? enExample  // 이미 [뜻]\nA:...\n→A:... 형태로 완성됨
      : koExample ? `${enExample}\n→ ${koExample}` : enExample

    setForm((prev) => ({
      ...prev,
      translation: forceUpdate || !prev.translation.trim() ? translationText : prev.translation,
      example:
        forceUpdate || !prev.example.trim() || isLikelyAutoGeneratedExample(prev.example)
          ? exampleText
          : prev.example,
      itemType: resolvedItemType,
    }))

    if (editingId) {
      const nextItems = items.map((item) => {
        if (item.id !== editingId) return item
        const nextTranslation =
          forceUpdate || !item.translation.trim() ? translationText : item.translation
        const nextExample =
          forceUpdate || !item.example.trim() || isLikelyAutoGeneratedExample(item.example)
            ? exampleText
            : item.example
        return { ...item, translation: nextTranslation, example: nextExample, itemType: resolvedItemType }
      })
      void persist(nextItems)
    }

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
                    onChange={(event) => {
                      const phrase = event.target.value
                      setForm((prev) => ({
                        ...prev,
                        phrase,
                        itemType: inferItemTypeAuto(phrase.trim(), ''),
                      }))
                    }}
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
                  {ITEM_TYPE_LABEL[form.itemType]}
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
          <section
            className="modal detail card-detail-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h3>상세 보기</h3>
              <button type="button" onClick={() => setIsDetailOpen(false)} aria-label="닫기">
                ✕
              </button>
            </header>
            <div className="card-detail-body">
              <section className="det-sec det-sec--phrase" aria-labelledby="det-phrase-heading">
                <div className="det-phrase-line">
                  <h2 id="det-phrase-heading" className="det-phrase-title">
                    {detailItem.phrase}
                  </h2>
                  <span
                    className={`item-type-pill item-type-${detailItem.itemType ?? inferItemType(detailItem.phrase)}`}
                  >
                    {ITEM_TYPE_LABEL[detailItem.itemType ?? inferItemType(detailItem.phrase)]}
                  </span>
                </div>
              </section>

              {/* 뜻 + 예문 아코디언 */}
              {(() => {
                const blocks = parseMeaningBlocks(
                  detailItem.example,
                  detailTranslation.primary || detailItem.translation,
                  detailTranslation.secondary,
                )
                const allMeanings = [
                  detailTranslation.primary || detailItem.translation,
                  ...detailTranslation.secondary,
                ].filter(Boolean)

                if (blocks.length === 0) {
                  return (
                    <section className="det-sec det-sec--meaning" aria-labelledby="det-meaning-heading">
                      <h4 className="det-sec-title">한글 뜻</h4>
                      <p className="det-trans">{detailItem.translation || '—'}</p>
                    </section>
                  )
                }

                return (
                  <section className="det-sec det-sec--meanings-accordion">
                    <h4 className="det-sec-title">뜻 &amp; 예문</h4>
                    {allMeanings.map((meaning, idx) => {
                      const block = blocks[idx] ?? blocks[0]
                      const isOpen = openMeaningIdx === idx
                      return (
                        <div key={idx} className={`meaning-accordion-item${isOpen ? ' open' : ''}`}>
                          <button
                            type="button"
                            className="meaning-accordion-header"
                            onClick={() => setOpenMeaningIdx(isOpen ? -1 : idx)}
                            aria-expanded={isOpen}
                          >
                            <span className="meaning-accordion-num">뜻 {idx + 1}</span>
                            <span className="meaning-accordion-text">{meaning}</span>
                            <span className="meaning-accordion-arrow">{isOpen ? '▲' : '▼'}</span>
                          </button>
                          {isOpen && (
                            <div className="meaning-accordion-body">
                              {block.description && (
                                <p className="meaning-accordion-desc">💡 {block.description}</p>
                              )}
                              {block.dialogue ? (
                                <div className="det-example-box">
                                  {highlightPhrase(block.dialogue, detailItem.phrase)}
                                </div>
                              ) : (
                                <p className="det-empty-line">예문 없음</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {/* 예문에서 뜻보다 더 많은 블록이 있을 경우 보여주기 */}
                    {blocks.slice(allMeanings.length).map((block, i) => {
                      const idx = allMeanings.length + i
                      const isOpen = openMeaningIdx === idx
                      return (
                        <div key={idx} className={`meaning-accordion-item${isOpen ? ' open' : ''}`}>
                          <button
                            type="button"
                            className="meaning-accordion-header"
                            onClick={() => setOpenMeaningIdx(isOpen ? -1 : idx)}
                            aria-expanded={isOpen}
                          >
                            <span className="meaning-accordion-num">뜻 {idx + 1}</span>
                            <span className="meaning-accordion-text">{block.meaning || '기타'}</span>
                            <span className="meaning-accordion-arrow">{isOpen ? '▲' : '▼'}</span>
                          </button>
                          {isOpen && (
                            <div className="meaning-accordion-body">
                              {block.description && (
                                <p className="meaning-accordion-desc">💡 {block.description}</p>
                              )}
                              {block.dialogue ? (
                                <div className="det-example-box">
                                  {highlightPhrase(block.dialogue, detailItem.phrase)}
                                </div>
                              ) : (
                                <p className="det-empty-line">예문 없음</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </section>
                )
              })()}

              <section className="det-sec det-sec--extra" aria-labelledby="det-extra-heading">
                <h4 id="det-extra-heading" className="det-sec-title">
                  기타 · 태그 · 학습 상태
                </h4>
                <div className="det-extra-chips chips">
                  <span className="chip-status">{STATUS_LABEL[detailItem.status]}</span>
                  {detailItem.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
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
                  <button type="button" onClick={() => updateStatus(detailItem.id, 'new')}>
                    → 새 단어
                  </button>
                  <button type="button" onClick={() => updateStatus(detailItem.id, 'learning')}>
                    → 학습 중
                  </button>
                  <button type="button" onClick={() => updateStatus(detailItem.id, 'mastered')}>
                    → 완료
                  </button>
                </div>
              </section>

              <section
                className="det-sec det-sec--context det-sec--context-bottom"
                aria-labelledby="det-context-heading"
              >
                <h4 id="det-context-heading" className="det-sec-title">
                  추가 정보
                </h4>
                <dl className="det-dl">
                  <dt>드라마 / 작품</dt>
                  <dd>{detailItem.show.trim() || '—'}</dd>
                  <dt>에피소드</dt>
                  <dd>{detailItem.episode.trim() || '—'}</dd>
                  <dt>덱</dt>
                  <dd>{detailItem.deck.trim() || '—'}</dd>
                  <dt>난이도</dt>
                  <dd>{'★'.repeat(detailItem.difficulty) || '—'}</dd>
                  <dt>카드 정보 프로파일</dt>
                  <dd>
                    {detailItem.profileId
                      ? detailProfile?.name ?? '(삭제된 프로파일)'
                      : '—'}
                  </dd>
                  {detailItem.notes.trim() ? (
                    <>
                      <dt>메모</dt>
                      <dd className="det-dd-notes">{detailItem.notes}</dd>
                    </>
                  ) : null}
                </dl>
                {detailPhraseWords.length >= 2 && (
                  <div className="det-phrase-words-inner" aria-labelledby="det-words-intro">
                    <p id="det-words-intro" className="det-phrase-words-intro">
                      추가 정보는 포함된 단어 — 클릭하면 새 카드로 추가합니다
                    </p>
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
              </section>
            </div>
            <footer className="card-detail-footer">
              <button type="button" className="secondary" onClick={() => openEditModal(detailItem)}>
                수정
              </button>
              <button type="button" className="danger" onClick={() => removeItem(detailItem.id)}>
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
