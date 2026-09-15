/**
 * A small Korean recall set for comparing search channels. Statements are grouped into sessions
 * the way a project's conversations would be; each query names the statement it should find first.
 * Queries use different words, particles, endings, spacing and Korean/English mixes than the
 * statements, and the corpus has distractors that share surface words.
 */
export interface RecallStatement {
  readonly key: string;
  readonly text: string;
}

export const recallSessions: readonly (readonly RecallStatement[])[] = [
  [
    { key: "log-format", text: "로그 포맷은 JSON Lines로 통일하기로 했어요." },
    { key: "log-level", text: "운영 환경 로그 레벨은 warn 이상만 남기자." },
    { key: "log-retention", text: "로그 보관 기간은 30일로 정했습니다." },
    { key: "log-tool", text: "로그 수집기는 Vector를 쓰고 Loki로 보내요." },
    { key: "metrics", text: "지표는 Prometheus로 모으고 대시보드는 Grafana." },
  ],
  [
    { key: "db-choice", text: "메인 데이터베이스는 PostgreSQL 16으로 가기로 결정했다." },
    { key: "db-local", text: "로컬 개발에서는 SQLite 파일 하나로 충분해요." },
    {
      key: "migrations",
      text: "마이그레이션은 drizzle-kit으로 생성하고 사람이 검토한 뒤 적용한다.",
    },
    { key: "backup", text: "DB 백업은 매일 새벽 3시에 S3로 올린다." },
    { key: "orm", text: "ORM은 쓰지 않고 쿼리 빌더만 쓰기로 했어요." },
  ],
  [
    { key: "deploy-day", text: "배포는 화요일과 목요일 오후에만 한다." },
    { key: "deploy-freeze", text: "연말에는 12월 20일부터 배포를 동결합니다." },
    { key: "rollback", text: "문제가 생기면 이전 이미지 태그로 즉시 롤백하는 게 원칙이에요." },
    { key: "ci", text: "CI는 GitHub Actions로 돌리고 main에 머지되면 스테이징에 자동 배포." },
    { key: "canary", text: "프로덕션은 카나리 10%로 먼저 내보내고 30분 지켜본다." },
  ],
  [
    { key: "payment-pg", text: "결제 대행사는 토스페이먼츠로 계약했습니다." },
    { key: "refund", text: "환불은 결제 후 7일 안에만 자동으로 처리해요." },
    { key: "currency", text: "해외 결제는 당분간 받지 않고 원화만 지원한다." },
    { key: "invoice", text: "세금계산서 발행은 매달 말일에 한꺼번에 한다." },
    { key: "subscription", text: "구독 요금은 월 9,900원, 연간은 99,000원으로 하자." },
  ],
  [
    { key: "code-style", text: "들여쓰기는 스페이스 두 칸, 따옴표는 큰따옴표로 맞춰요." },
    { key: "test-framework", text: "테스트 러너는 vitest로 통일합니다." },
    { key: "review-rule", text: "PR은 최소 한 명이 승인해야 머지할 수 있다." },
    { key: "branch", text: "브랜치 이름은 feat/ 또는 fix/로 시작하게 하자." },
    { key: "commit-lang", text: "커밋 메시지는 한국어로 쓰고 conventional commits 형식을 따른다." },
  ],
  [
    { key: "frontend-fw", text: "프론트엔드는 React Router v8로 새로 만들기로 했어요." },
    { key: "ui-kit", text: "UI 컴포넌트는 shadcn으로만 추가한다." },
    { key: "state", text: "전역 상태 관리 라이브러리는 도입하지 않는다." },
    { key: "i18n", text: "다국어 지원은 1차 출시 범위에서 뺐습니다." },
    { key: "dark-mode", text: "다크 모드는 시스템 설정을 따라가게 해 주세요." },
  ],
  [
    { key: "auth", text: "로그인은 카카오와 구글 소셜 로그인만 제공한다." },
    { key: "session-ttl", text: "세션 만료 시간은 14일로 합시다." },
    { key: "password", text: "비밀번호 로그인은 지원하지 않기로 했다." },
    { key: "2fa", text: "관리자 계정에는 OTP 이중 인증을 반드시 켠다." },
    { key: "rate-limit", text: "API 호출 제한은 IP당 분당 60회로 걸어요." },
  ],
  [
    { key: "meeting", text: "주간 회의는 매주 월요일 오전 10시에 30분만 해요." },
    { key: "oncall", text: "당직은 2주씩 돌아가면서 맡는다." },
    { key: "vacation", text: "휴가는 최소 일주일 전에 캘린더에 올려 주세요." },
    { key: "docs", text: "설계 결정은 docs/decisions.md에 날짜와 함께 남긴다." },
    { key: "retro", text: "스프린트 회고는 격주 금요일 오후 4시." },
  ],
  [
    { key: "search-engine", text: "사내 검색은 Meilisearch 대신 OpenSearch를 쓰기로 바꿨다." },
    { key: "cache", text: "캐시는 Redis 하나로 하고 TTL은 기본 5분." },
    { key: "queue", text: "비동기 작업 큐는 BullMQ를 사용합니다." },
    { key: "storage", text: "업로드 파일은 S3 버킷에 저장하고 CloudFront로 서빙." },
    { key: "email", text: "메일 발송은 Amazon SES를 쓰기로 했어요." },
  ],
];

export interface RecallQuery {
  readonly query: string;
  readonly expected: string;
}

export const recallQueries: readonly RecallQuery[] = [
  { query: "로그 형식을 뭐로 정했었지?", expected: "log-format" },
  { query: "운영에서 로그는 어느 수준부터 남기기로 했나", expected: "log-level" },
  { query: "로그를 며칠 동안 보관하지?", expected: "log-retention" },
  { query: "대시보드 도구 뭐 쓰기로 했더라", expected: "metrics" },
  { query: "주 DB를 무엇으로 하기로 했나요", expected: "db-choice" },
  { query: "개발 PC에서는 어떤 데이터베이스 써?", expected: "db-local" },
  { query: "스키마 변경은 어떻게 반영하기로 했지", expected: "migrations" },
  { query: "데이터베이스 백업 시간 언제야", expected: "backup" },
  { query: "ORM 도입했었나?", expected: "orm" },
  { query: "무슨 요일에 배포할 수 있지?", expected: "deploy-day" },
  { query: "연말 배포 금지는 언제부터?", expected: "deploy-freeze" },
  { query: "장애 나면 되돌리는 방법이 뭐였지", expected: "rollback" },
  { query: "카나리 배포 비율 몇 퍼센트로 했더라", expected: "canary" },
  { query: "PG사 어디랑 계약했어?", expected: "payment-pg" },
  { query: "환불 가능 기간이 며칠이지", expected: "refund" },
  { query: "달러 결제도 받나요?", expected: "currency" },
  { query: "구독 가격 얼마로 정했지", expected: "subscription" },
  { query: "인덴트는 몇 칸으로 하기로 했나", expected: "code-style" },
  { query: "테스트 프레임워크 뭐 쓰지?", expected: "test-framework" },
  { query: "머지하려면 리뷰 승인이 몇 명 필요해?", expected: "review-rule" },
  { query: "커밋 메시지 언어는?", expected: "commit-lang" },
  { query: "프론트 프레임워크 무엇으로 새로 만들기로 했지", expected: "frontend-fw" },
  { query: "상태관리 라이브러리 쓰기로 했었나", expected: "state" },
  { query: "다국어는 첫 출시에 들어가?", expected: "i18n" },
  { query: "소셜 로그인 어떤 거 지원하지", expected: "auth" },
  { query: "로그인 유지 기간 얼마로 하기로 했지", expected: "session-ttl" },
  { query: "관리자 계정 보안 설정 뭐 켜야 해?", expected: "2fa" },
  { query: "정기 회의 무슨 요일 몇 시야", expected: "meeting" },
  { query: "당직 순번은 얼마나 자주 바뀌어", expected: "oncall" },
  { query: "검색 엔진 뭘로 바꿨지?", expected: "search-engine" },
  { query: "작업 큐 라이브러리 뭐였지", expected: "queue" },
  { query: "이메일 보내는 서비스 뭐 쓰기로 했어", expected: "email" },
];
