import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Status = 'new' | 'learning' | 'mastered'

type StudyItem = {
  id: string
  phrase: string
  translation: string
  show: string
  tags: string[]
  status: Status
  reviewCount: number
  lastReviewedAt?: string
}

type Page = 'dashboard' | 'list' | 'board' | 'cards'

const STORAGE_KEY = 'midani.study.items.v1'

const STATUS_LABEL: Record<Status, string> = {
  new: '신규',
  learning: '학습중',
  mastered: '완료',
}

const SAMPLE_ITEMS: StudyItem[] = [
  {
    id: crypto.randomUUID(),
    phrase: "I'm a bit tied up right now.",
    translation: '지금 좀 바빠요.',
    show: 'Friends',
    tags: ['일상', '비즈니스'],
    status: 'learning',
    reviewCount: 1,
  },
  {
    id: crypto.randomUUID(),
    phrase: 'Cut it out!',
    translation: '그만해!',
    show: 'The Simpsons',
    tags: ['감정', '짧은표현'],
    status: 'new',
    reviewCount: 0,
  },
  {
    id: crypto.randomUUID(),
    phrase: "I'll take a rain check.",
    translation: '다음 기회에 할게요.',
    show: 'How I Met Your Mother',
    tags: ['약속', '거절'],
    status: 'mastered',
    reviewCount: 5,
    lastReviewedAt: new Date().toISOString(),
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

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [items, setItems] = useState<StudyItem[]>(() => loadItems())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all')
  const [newPhrase, setNewPhrase] = useState('')
  const [newTranslation, setNewTranslation] = useState('')
  const [newShow, setNewShow] = useState('')
  const [newTags, setNewTags] = useState('')
  const [cardIndex, setCardIndex] = useState(0)
  const [cardFlipped, setCardFlipped] = useState(false)

  const persist = (next: StudyItem[]) => {
    setItems(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      const byStatus = statusFilter === 'all' ? true : item.status === statusFilter
      if (!byStatus) return false
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
      shows: new Set(items.map((item) => item.show)).size,
    }),
    [items],
  )

  const cardItems = useMemo(
    () => items.filter((item) => item.status !== 'mastered' || item.reviewCount < 3),
    [items],
  )

  const currentCard = cardItems[cardIndex]

  const moveStatus = (id: string, status: Status) => {
    persist(items.map((item) => (item.id === id ? { ...item, status } : item)))
  }

  const handleAdd = (e: FormEvent) => {
    e.preventDefault()
    if (!newPhrase.trim() || !newTranslation.trim()) return
    const newItem: StudyItem = {
      id: crypto.randomUUID(),
      phrase: newPhrase.trim(),
      translation: newTranslation.trim(),
      show: newShow.trim() || 'Unknown',
      tags: newTags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      status: 'new',
      reviewCount: 0,
    }
    const next = [newItem, ...items]
    persist(next)
    setNewPhrase('')
    setNewTranslation('')
    setNewShow('')
    setNewTags('')
  }

  const rateCard = (score: 1 | 2 | 3) => {
    if (!currentCard) return
    const next = items.map((item): StudyItem =>
      item.id === currentCard.id
        ? {
            ...item,
            reviewCount: item.reviewCount + 1,
            lastReviewedAt: new Date().toISOString(),
            status: (score === 3 ? 'mastered' : score === 2 ? 'learning' : 'new') as Status,
          }
        : item,
    )
    persist(next)
    setCardFlipped(false)
    setCardIndex((prev) => (cardItems.length === 0 ? 0 : (prev + 1) % cardItems.length))
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Mid/Ani English</h1>
        <p>미드/애니 영어 구문 학습</p>
        <nav>
          <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>
            대시보드
          </button>
          <button className={page === 'list' ? 'active' : ''} onClick={() => setPage('list')}>
            리스트
          </button>
          <button className={page === 'board' ? 'active' : ''} onClick={() => setPage('board')}>
            칸반
          </button>
          <button className={page === 'cards' ? 'active' : ''} onClick={() => setPage('cards')}>
            플래시카드
          </button>
        </nav>
      </aside>

      <main className="content">
        <header className="top">
          <div>
            <h2>학습 노트</h2>
            <span>Slack/Trello 스타일의 반복 학습 보드</span>
          </div>
          <div className="summary">
            <strong>{stats.total}</strong> 항목
          </div>
        </header>

        <section className="add-form-wrap">
          <form onSubmit={handleAdd} className="add-form">
            <input
              placeholder="영어 구문"
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
            />
            <input
              placeholder="한국어 뜻"
              value={newTranslation}
              onChange={(e) => setNewTranslation(e.target.value)}
            />
            <input placeholder="작품명" value={newShow} onChange={(e) => setNewShow(e.target.value)} />
            <input
              placeholder="태그(쉼표 구분)"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
            />
            <button type="submit">추가</button>
          </form>
        </section>

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
            <section className="filters">
              <input placeholder="검색..." value={query} onChange={(e) => setQuery(e.target.value)} />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | Status)}
              >
                <option value="all">모든 상태</option>
                <option value="new">신규</option>
                <option value="learning">학습중</option>
                <option value="mastered">완료</option>
              </select>
            </section>
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>구문</th>
                    <th>뜻</th>
                    <th>작품</th>
                    <th>상태</th>
                    <th>태그</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.id}>
                      <td>{item.phrase}</td>
                      <td>{item.translation}</td>
                      <td>{item.show}</td>
                      <td>{STATUS_LABEL[item.status]}</td>
                      <td>{item.tags.join(', ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                    <article key={item.id} className="card">
                      <strong>{item.phrase}</strong>
                      <p>{item.translation}</p>
                      <small>{item.show}</small>
                      <div className="card-actions">
                        {status !== 'new' && (
                          <button onClick={() => moveStatus(item.id, 'new')}>신규</button>
                        )}
                        {status !== 'learning' && (
                          <button onClick={() => moveStatus(item.id, 'learning')}>학습중</button>
                        )}
                        {status !== 'mastered' && (
                          <button onClick={() => moveStatus(item.id, 'mastered')}>완료</button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
            ))}
          </section>
        )}

        {page === 'cards' && (
          <section className="flashcard-wrap">
            {currentCard ? (
              <>
                <button
                  className={`flashcard ${cardFlipped ? 'flipped' : ''}`}
                  onClick={() => setCardFlipped((prev) => !prev)}
                >
                  <div className="front">{currentCard.phrase}</div>
                  <div className="back">{currentCard.translation}</div>
                </button>
                <div className="rate-buttons">
                  <button onClick={() => rateCard(1)}>어려움</button>
                  <button onClick={() => rateCard(2)}>보통</button>
                  <button onClick={() => rateCard(3)}>쉬움</button>
                </div>
              </>
            ) : (
              <p>복습할 카드가 없습니다.</p>
            )}
          </section>
        )}
      </main>
    </div>
  )
}

export default App
