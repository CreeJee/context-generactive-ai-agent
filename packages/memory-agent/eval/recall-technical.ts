import type { RecallQuery, RecallStatement } from "./recall-corpus.ts";

/**
 * A recall set of what coding sessions leave behind: tool output with error codes, file contents,
 * commands and paths, as Claude Code and Codex transcripts carry them. Queries name the exact
 * strings a person remembers (an error code, a hook name, part of a pod name) or describe them in
 * Korean. Three long outputs hold their key line past the 2048 tokens the embedder reads, and
 * distractors share the surface of the right answer.
 */

const tail = (filler: (index: number) => string, lines: number, last: string) =>
  `${Array.from({ length: lines }, (_, index) => filler(index)).join("\n")}\n${last}`;

export const technicalSessions: readonly (readonly RecallStatement[])[] = [
  [
    {
      key: "pnpm-lockfile",
      kind: "tool_result",
      text: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with packages/web/package.json',
    },
    {
      key: "pnpm-store",
      kind: "tool_result",
      text: "ERR_PNPM_STORE_BREAKING_CHANGE  The store used for the current node_modules is incompatible with the current pnpm version",
    },
    {
      key: "lockfile-fix",
      kind: "assistant",
      text: "lockfile이 package.json과 어긋나서 설치가 막혔어요. pnpm install로 lockfile을 갱신했습니다.",
    },
    {
      key: "tsc-error",
      kind: "tool_result",
      text: "src/routes/orders.ts(42,17): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
    },
    {
      key: "tsc-cart",
      kind: "tool_result",
      text: "src/routes/cart.ts(18,5): error TS2322: Type 'number' is not assignable to type 'string'.",
    },
    {
      key: "vitest-timeout",
      kind: "tool_result",
      text: "FAIL  tests/payment.test.ts > refund > retries twice\nError: Test timed out in 5000ms.",
    },
  ],
  [
    {
      key: "enoent-config",
      kind: "tool_result",
      text: "Error: ENOENT: no such file or directory, open '/srv/app/config/production.yaml'\n    at Object.openSync (node:fs:573:18)",
    },
    {
      key: "eaddrinuse",
      kind: "tool_result",
      text: "Error: listen EADDRINUSE: address already in use 127.0.0.1:5174",
    },
    {
      key: "eaddrinuse-3000",
      kind: "tool_result",
      text: "Error: listen EADDRINUSE: address already in use :::3000",
    },
    {
      key: "sqlite-busy",
      kind: "tool_result",
      text: "SqliteError: database is locked (SQLITE_BUSY)\n    at Statement.run (/app/node_modules/better-sqlite3/lib/methods/wrappers.js:5:21)",
    },
    {
      key: "cors",
      kind: "tool_result",
      text: "Access to fetch at 'https://api.shop.example/v1/orders' from origin 'http://localhost:3000' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    },
    {
      key: "oom",
      kind: "tool_result",
      text: "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    },
  ],
  [
    {
      key: "use-lease-hook",
      kind: "tool_result",
      text: "export function useSessionLease(sessionId: string) {\n  const [holder, setHolder] = useState<string | null>(null);\n  useEffect(() => {\n    void claimLease(sessionId).then(setHolder);\n  }, [sessionId]);\n  return holder;\n}",
    },
    {
      key: "use-session-list",
      kind: "tool_result",
      text: "export function useSessionList(projectId: string) {\n  const [sessions, setSessions] = useState<Session[]>([]);\n  useEffect(() => {\n    void listSessions(projectId).then(setSessions);\n  }, [projectId]);\n  return sessions;\n}",
    },
    {
      key: "retry-policy",
      kind: "tool_result",
      text: "export const retryPolicy = {\n  maxAttempts: 3,\n  backoffMs: [200, 800, 3200],\n  retryOn: ['ECONNRESET', 'ETIMEDOUT'],\n};",
    },
    {
      key: "feature-flag",
      kind: "tool_call",
      text: 'Edit {"file_path":"src/flags.ts","old_string":"enableNewCheckout: false","new_string":"enableNewCheckout: true"}',
    },
    {
      key: "env-var",
      kind: "tool_result",
      text: "warn: PAYMENT_WEBHOOK_SECRET is not set; webhook signature verification skipped",
    },
    {
      key: "migration-file",
      kind: "tool_call",
      text: 'Read {"file_path":"packages/api/src/db/migrations/0007_add_refund_reason.sql"}',
    },
  ],
  [
    {
      key: "docker-redis",
      kind: "tool_call",
      text: 'Bash {"command":"docker run -d -p 6379:6379 --name cache redis:7.2-alpine"}',
    },
    {
      key: "git-bisect",
      kind: "tool_result",
      text: "a1b2c3d4e5 is the first bad commit\ncommit a1b2c3d4e5\n\n    perf: 주문 목록 쿼리에 인덱스 힌트 추가",
    },
    {
      key: "curl-429",
      kind: "tool_result",
      text: "HTTP/2 429\ncontent-type: application/json\nretry-after: 30\nx-ratelimit-remaining: 0",
    },
    {
      key: "k8s-crashloop",
      kind: "tool_result",
      text: "NAME                           READY   STATUS             RESTARTS   AGE\norders-api-7d9f8c6b5-x2k4p     0/1     CrashLoopBackOff   6          12m\ncart-api-5c4b9d7f8-q7w2e       1/1     Running            0          3d",
    },
  ],
  [
    {
      key: "long-build-log",
      kind: "tool_result",
      text: tail(
        (index) => `[webpack] compiled module ./src/components/Item${index}.tsx 1.2 KiB [built]`,
        600,
        "ERROR in ./src/pages/Checkout.tsx 88:14\nModule not found: Error: Can't resolve '@shop/payments-sdk' in '/app/src/pages'",
      ),
    },
    {
      key: "long-test-log",
      kind: "tool_result",
      text: tail(
        (index) => ` ✓ cart > adds item ${index} to the basket (2 ms)`,
        500,
        " ✗ cart > applies coupon WELCOME10 (15 ms)\nAssertionError: expected 9000 to equal 8100",
      ),
    },
    {
      key: "long-build-ok",
      kind: "tool_result",
      text: tail(
        (index) => `[webpack] compiled module ./src/pages/Page${index}.tsx 2.4 KiB [built]`,
        600,
        "webpack 5.98.0 compiled successfully in 8123 ms",
      ),
    },
  ],
  [
    { key: "node-version", kind: "user", text: "Node는 22 LTS로 고정하고 .nvmrc에 적어 두자." },
    {
      key: "port-choice",
      kind: "assistant",
      text: "개발 서버 포트는 5174로 옮겼어요. 5173은 다른 앱이 쓰고 있었어요.",
    },
    {
      key: "index-hint",
      kind: "user",
      text: "주문 목록이 느리면 orders(created_at) 인덱스부터 확인해.",
    },
  ],
];

export const technicalQueries: readonly RecallQuery[] = [
  // The exact string a person remembers.
  { query: "ERR_PNPM_OUTDATED_LOCKFILE", expected: "pnpm-lockfile" },
  { query: "TS2345 orders.ts", expected: "tsc-error" },
  { query: "payment.test.ts 타임아웃", expected: "vitest-timeout" },
  { query: "production.yaml ENOENT", expected: "enoent-config" },
  { query: "EADDRINUSE 5174", expected: "eaddrinuse" },
  { query: "SQLITE_BUSY", expected: "sqlite-busy" },
  { query: "Access-Control-Allow-Origin", expected: "cors" },
  { query: "useSessionLease", expected: "use-lease-hook" },
  { query: "retryPolicy backoffMs", expected: "retry-policy" },
  { query: "enableNewCheckout", expected: "feature-flag" },
  { query: "PAYMENT_WEBHOOK_SECRET", expected: "env-var" },
  { query: "0007_add_refund_reason", expected: "migration-file" },
  { query: "redis:7.2-alpine", expected: "docker-redis" },
  { query: "a1b2c3d4e5", expected: "git-bisect" },
  { query: "retry-after 429", expected: "curl-429" },
  { query: "orders-api-7d9f8c6b5", expected: "k8s-crashloop" },
  { query: "ECONNRESET", expected: "retry-policy" },
  // The key line lies past the part the embedder reads.
  { query: "@shop/payments-sdk Can't resolve", expected: "long-build-log" },
  { query: "WELCOME10 쿠폰", expected: "long-test-log" },
  // Described in words rather than quoted.
  { query: "메모리 부족으로 죽은 빌드", expected: "oom" },
  { query: "설정 파일을 못 찾은 오류", expected: "enoent-config" },
  { query: "레디스 컨테이너 띄운 명령", expected: "docker-redis" },
  { query: "파드가 계속 재시작되는 문제", expected: "k8s-crashloop" },
  { query: "호출 제한에 걸린 응답", expected: "curl-429" },
  { query: "Node 버전 고정", expected: "node-version" },
  { query: "개발 서버 포트를 왜 바꿨지", expected: "port-choice" },
  { query: "주문 목록 느릴 때 볼 인덱스", expected: "index-hint" },
];
