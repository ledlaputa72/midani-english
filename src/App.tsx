import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Status = 'new' | 'learning' | 'mastered'
type Page = 'dashboard' | 'list' | 'board' | 'cards'
type InputTab = 'text' | 'ocr'
type CardRating = 'again' | 'good' | 'easy' | 'skip'

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
  status: Status
  reviewCount: number
  createdAt: string
  lastReviewedAt?: string
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
}

const STORAGE_KEY = 'midani.study.items.v2'

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
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : SAMPLE_ITEMS
  } catch {
    return SAMPLE_ITEMS
  }
}

function dateText(value?: string): string {
  if (!value) return '없음'
  return value
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
  }
}

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [items, setItems] = useState<StudyItem[]>(() => loadItems())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all')

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [inputTab, setInputTab] = useState<InputTab>('text')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const [cardIndex, setCardIndex] = useState(0)
  const [cardFlipped, setCardFlipped] = useState(false)

  const persist = (next: StudyItem[]) => {
    setItems(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) return false
      if (!q) return true
      return (
        item.phrase.toLowerCase().includes(q) ||
        item.translation.toLowerCase().includes(q) ||
        item.show.toLowerCase().includes(q) ||
        item.tags.some((tag) => tag.toLowerCase().includes(q))
      )
    })
  }, [items, query, statusFilter])

  const stats = useMemo(
    () => ({
      total: items.length,
      learning: items.filter((item) => item.status === 'learning').length,
      mastered: items.filter((item) => item.status === 'mastered').length,
      shows: new Set(items.map((item) => item.show).filter(Boolean)).size,
    }),
    [items],
  )

  const cardItems = useMemo(() => {
    return items.filter((item) => item.status !== 'mastered' || item.reviewCount < 3)
  }, [items])

  const currentCard = cardItems[cardIndex] ?? null
  const detailItem = detailId ? items.find((item) => item.id === detailId) ?? null : null

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
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAddOpen(false)
        setIsDetailOpen(false)
      }
      if (page === 'cards' && !isAddOpen && !isDetailOpen) {
        if (event.key === ' ') {
          event.preventDefault()
          setCardFlipped((prev) => !prev)
        }
        if (event.key === '1') rateCard('again')
        if (event.key === '2') rateCard('good')
        if (event.key === '3') rateCard('easy')
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [page, isAddOpen, isDetailOpen, currentCard])

  const openCreateModal = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setInputTab('text')
    setIsAddOpen(true)
  }

  const openEditModal = (item: StudyItem) => {
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
  }

  const nextCard = () => {
    if (cardItems.length === 0) return
    setCardIndex((prev) => (prev + 1 >= cardItems.length ? 0 : prev + 1))
    setCardFlipped(false)
  }

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
        </nav>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <h2>학습 노트</h2>
            <p>프로토타입 기반 모달 + 카드 학습 흐름</p>
          </div>
          <button className="primary" onClick={openCreateModal}>
            단어 / 구문 추가
          </button>
        </header>

        {page === 'dashboard' && (
          <section className="stats-grid">
            <article>
              <small>전체</small>
              <strong>{stats.total}</strong>
            </article>
            <article>
              <small>학습중</small>
              <strong>{stats.learning}</strong>
            </article>
            <article>
              <small>완료</small>
              <strong>{stats.mastered}</strong>
            </article>
            <article>
              <small>작품수</small>
              <strong>{stats.shows}</strong>
            </article>
          </section>
        )}

        {page === 'list' && (
          <>
            <section className="toolbar">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="구문, 해석, 태그 검색"
              />
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as 'all' | Status)}
              >
                <option value="all">전체 상태</option>
                <option value="new">새 단어</option>
                <option value="learning">학습 중</option>
                <option value="mastered">완료</option>
              </select>
            </section>
            <section className="list-grid">
              {filteredItems.map((item) => (
                <button key={item.id} className="item-card" onClick={() => openDetailModal(item.id)}>
                  <strong>{item.phrase}</strong>
                  <p>{item.translation}</p>
                  <div className="chips">
                    <span>{STATUS_LABEL[item.status]}</span>
                    <span>{item.show || '작품 미입력'}</span>
                  </div>
                </button>
              ))}
            </section>
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
            {currentCard ? (
              <>
                <p className="card-counter">
                  {cardIndex + 1} / {cardItems.length} 카드 · {currentCard.show || 'Unknown'}
                </p>
                <button className={`flashcard ${cardFlipped ? 'flipped' : ''}`} onClick={() => setCardFlipped((prev) => !prev)}>
                  {!cardFlipped ? (
                    <div>
                      <span>클릭해서 뜻 확인</span>
                      <h3>{currentCard.phrase}</h3>
                      {currentCard.example && <p>"{currentCard.example}"</p>}
                    </div>
                  ) : (
                    <div>
                      <span>뜻</span>
                      <h3>{currentCard.translation}</h3>
                      {currentCard.notes && <p>{currentCard.notes}</p>}
                    </div>
                  )}
                </button>
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
              </>
            ) : (
              <div className="empty">복습할 카드가 없습니다.</div>
            )}
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
              <div className="ocr-placeholder">
                OCR 탭 UI만 우선 연결했습니다. 실제 OCR 엔진 연동은 다음 단계에서 추가 가능합니다.
              </div>
            )}
            <form onSubmit={onSubmitAdd} className="modal-form">
              <label>
                영어 단어 / 구문 *
                <input
                  value={form.phrase}
                  onChange={(event) => setForm((prev) => ({ ...prev, phrase: event.target.value }))}
                />
              </label>
              <label>
                한국어 뜻 *
                <input
                  value={form.translation}
                  onChange={(event) => setForm((prev) => ({ ...prev, translation: event.target.value }))}
                />
              </label>
              <label>
                예문
                <textarea
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
            <p className="det-trans">{detailItem.translation}</p>
            {detailItem.example && <div className="det-box">"{detailItem.example}"</div>}
            <div className="chips">
              <span>{STATUS_LABEL[detailItem.status]}</span>
              <span>{detailItem.show || '작품 미입력'}</span>
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
