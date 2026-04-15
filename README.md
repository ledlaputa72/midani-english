# Mid/Ani English Study App

미드/애니 영어 학습을 위한 React 기반 웹앱입니다.  
기존 HTML 프로토타입을 바탕으로 아래 핵심 기능을 우선 구현했습니다.

- 리스트형 학습 항목 관리 (검색/상태 필터)
- Trello 스타일 칸반 보드 (신규/학습중/완료 이동)
- 플래시카드 반복 학습 (난이도 평가)
- 로컬 스토리지 저장 (`localStorage`)

## Tech Stack

- React + TypeScript + Vite
- CSS (커스텀 스타일)
- Vercel 배포 호환

## Local Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## GitHub 연결

아래는 로컬에서 한 번만 실행하면 됩니다.

```bash
git init
git add .
git commit -m "feat: initialize React app for mid/ani English learning"
git branch -M main
git remote add origin https://github.com/<YOUR_ID>/<REPO_NAME>.git
git push -u origin main
```

## Vercel 배포

1. GitHub 저장소를 Vercel에 Import
2. Framework Preset: `Vite` 자동 감지
3. Build Command: `npm run build`
4. Output Directory: `dist`
5. Deploy

또는 CLI:

```bash
npm i -g vercel
vercel
```

