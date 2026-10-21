# 빌드 의존성 보안 관리

## 2026-10-21 정리 범위

Electron 41 및 electron-builder 26 계열을 유지하면서 보안 최소 버전과 잠금 파일을 갱신했다. 앱 버전, 앱 소스, vendored 화면 자산, Windows x64 설치형·포터블 대상과 설치 옵션은 변경하지 않았다.

| 항목 | 이전 잠금 버전 | 정리 후 잠금 버전 |
| --- | --- | --- |
| Electron | 41.2.1 | 41.10.7 |
| electron-builder 및 동일 버전 빌더 모듈 | 26.8.1 | 26.15.3 |
| builder-util-runtime | 9.5.1 | 9.7.0 |
| tar | 7.5.13 | 7.5.22 |
| DOMPurify | 3.4.14 | 3.4.17 |

전체 의존성의 잠금 파일 감사 결과는 **22개(치명적 1, 높음 16, 보통 4, 낮음 1) → 8개(모두 보통)**다. production-only 감사 결과는 낮음 1개에서 0개로 줄었다. 이 숫자는 전파된 의존성 경고를 포함하며 독립 취약점 개수가 아니다. 원본 감사 JSON·설치·테스트 기록은 커밋하지 않는 `.codex/dependency-security/`에 보관한다.

Electron은 `devDependencies`에 있지만 배포되는 실행 엔진이다. 따라서 `npm audit --omit=dev`만으로 앱 런타임의 안전성을 판단하지 않는다. 또한 npm 감사는 `assets/js/` 등의 독립 vendored 파일을 검사하거나 갱신하지 않는다. 이번에는 기존 PDF·아이콘 자산과 `piexifjs` 런타임을 그대로 유지했다.

## 남은 보통 경고

원인은 `app-builder-lib → @electron/get 3.1.0 → global-agent 3.0.0 → roarr 2.15.4 → sprintf-js 1.1.3` 체인의 [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)(제한 없는 정밀도 지정으로 인한 서비스 거부)다. 빌더 상위 모듈로 전파되어 8개 패키지 경고로 표시된다.

- 확인 당시 `sprintf-js`의 최신 게시 버전은 1.1.3이며 수정 버전은 없다.
- 빌더의 `@electron/get` 제약은 3.x이고, 이 계열의 `global-agent` 제약은 3.x다. 더 높은 메이저가 존재해도 해당 제약과 호환되는 대체가 아니다.
- `npm audit fix --force`가 제안하는 electron-builder 26.5.0은 현재 최소 버전보다 낮으며, 이번에 제거한 취약한 빌더 경로를 다시 포함할 수 있다. 이를 보안 수정으로 채택하지 않는다.
- 경고를 숨기기 위한 optional 의존성 제외, 감사 제외, 호환 범위 밖의 일괄 `overrides`, prerelease 빌더 전환은 적용하지 않았다.

상위 빌더가 호환되는 다운로드 의존성 체인을 제공하면 다시 감사하고 기존 설치·실행 검증을 반복한다.

## 검증과 회귀 차단

Windows 워크플로는 기존 Node 24 환경을 유지하고 전체 의존성에 다음 검사를 적용한다.

```bash
npm audit --audit-level=high
```

높음·치명적 경고 또는 감사 실행 오류가 있으면 빌드를 중단한다. 보통 이하의 경고도 출력에 남기며, production-only 감사로 전체 검사를 대체하지 않는다.

다음 기존 검사를 그대로 실행한다.

1. `npm ci` 후 잠금 파일이 바뀌지 않는지 확인한다.
2. 전체 감사와 production-only 감사를 각각 기록한다.
3. `npm test` 및 `npm run test:electron`으로 메모·저장·캡처·반복 시간 이동·단축키·PDF·종료 전 저장을 검사한다.
4. Windows에서 `npm run build:win -- --publish never`를 실행한다.
5. 생성된 ASAR 코드를 대상으로 Electron smoke를 다시 실행한다.
6. `scripts/verify-windows.ps1`로 설치 성공, 설치된 앱 payload의 x64 아키텍처, 설치형·포터블 시작을 확인한다.

NSIS launcher 자체가 x86인 것과 설치된 앱 payload가 x64인 것은 구분한다. 서명 상태는 기존처럼 기록하며, 이번 작업으로 서명이나 배포 정책을 바꾸지 않는다. 검증용 Actions 산출물은 새 릴리스 게시를 의미하지 않는다.
