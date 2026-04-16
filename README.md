# Mid/Ani English Study App

미드/애니 영어 학습을 위한 React 기반 웹앱입니다.  
기존 HTML 프로토타입을 바탕으로 아래 핵심 기능을 우선 구현했습니다.

- 리스트형 학습 항목 관리 (검색/상태 필터)
- Trello 스타일 칸반 보드 (신규/학습중/완료 이동)
- 플래시카드 반복 학습 (난이도 평가)
- Google 로그인 + 사용자별 Firestore 동기화

## Tech Stack

- React + TypeScript + Vite
- CSS (커스텀 스타일)
- Vercel 배포 호환

## Local Development

```bash
npm install
npm run dev
```

## Firebase 설정 (필수)

1. Firebase Console에서 프로젝트 생성
2. Authentication > Sign-in method > Google 활성화
3. Firestore Database 생성
4. 프로젝트 루트에 `.env` 파일 생성 후 `.env.example` 값을 채우기

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

5. Firestore Rules 탭에 `firestore.rules` 내용을 반영해서 사용자별 접근 제한 적용

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

추가로 Vercel Environment Variables에 Firebase `VITE_FIREBASE_*` 키를 동일하게 등록하고,
Firebase Authentication의 Authorized domains에 Vercel 도메인을 추가하세요.

또는 CLI:

```bash
npm i -g vercel
vercel
```

