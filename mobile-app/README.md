# Mobile App Release Prep

이 프로젝트는 현재 반응형 웹앱이며, 아래 구조로 iOS/Android 앱(WebView 래핑) 전환을 준비합니다.

## Why this folder exists

- 모바일/태블릿 UX를 웹에서 먼저 고도화
- 이후 Capacitor 기반 네이티브 패키징으로 확장
- 앱 전용 설정/스크립트를 웹 코드와 분리해 관리

## Recommended next steps

1. Capacitor 초기화
2. `dist`를 웹 자산으로 연결
3. iOS/Android 프로젝트 생성
4. 푸시 알림, 딥링크, 인증 리다이렉트 도메인 점검

## Suggested commands

```bash
npm i @capacitor/core @capacitor/cli
npx cap init midani-english com.midani.english
npx cap add android
npx cap add ios
npm run build
npx cap sync
```

## Notes for this app

- 하단 탭 네비는 모바일 앱의 기본 UX 패턴을 따름
- `env(safe-area-inset-bottom)`을 사용해 노치/제스처 영역 대응
- Firebase Auth 도메인/리다이렉트 설정은 앱 번들 ID 기준으로 추가 점검 필요
