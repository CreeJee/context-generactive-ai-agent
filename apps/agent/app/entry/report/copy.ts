import type {
  ReportBundle,
  ReportDeliveryFailure,
  ReportDiagnosisFailure,
} from "memory-agent/definitions";
import type { ProblemCopy } from "../shared/copy-templates";
import type { BundleSection } from "./report-bundle";

/** Copy for the problem report page. Checked by tools/copy-check. */
export const reportCopy = {
  link: { label: "리포트하기" },
  page: {
    title: "문제 제보 · Context Agent",
    back: "← 앱으로 돌아가기",
    heading: "문제 제보",
    intro:
      "채팅이나 실행이 멈춰도 여기서 증상을 기록할 수 있습니다. 이 화면은 제보를 자동으로 전송하지 않습니다. 직접 누를 때만 개발자 Discord 웹훅으로 보냅니다.",
    drafting: "작성 중",
    status: {
      noSession: "세션 없이 열면 증상 설명만으로 제보합니다.",
      collecting: "세션의 증거 묶음을 모으는 중입니다. 증상은 계속 작성할 수 있습니다.",
      collected: "증거 묶음을 모았습니다. 아래에서 보낼 내용을 확인해 주십시오.",
      copied: "제보문과 증거 묶음을 복사했습니다. 개발자의 Discord 채널에 직접 붙여넣어 주십시오.",
    },
    sessionFailed: {
      what: "분석 세션을 열 수 없습니다.",
      next: "증상 제보문은 계속 작성·저장할 수 있습니다.",
    } satisfies ProblemCopy,
    evidenceFailed: {
      what: "증거 묶음을 모으지 못했습니다.",
      next: "증상만으로도 제보할 수 있습니다.",
    } satisfies ProblemCopy,
    clipboardFailed: {
      what: "클립보드를 사용할 수 없습니다.",
      next: "위 제보 문안에서 텍스트를 직접 선택해 복사해 주십시오.",
    } satisfies ProblemCopy,
    sessionOpened: "별도 분석 세션이 열렸습니다.",
    openSession: "분석 세션 보기",
    retrySession: "분석 세션 다시 열기",
    editing:
      "문안을 직접 편집 중입니다. 위 증상·진단을 바꾸거나 증거 묶음이 도착해도 현재 문안에는 자동 반영되지 않습니다.",
    regenerate: "설명·진단·증거 묶음으로 문안 다시 생성 (직접 편집한 내용 삭제)",
    diagnosisSection: "AI 진단",
    diagnosisHeading: "오류 진단과 제보 초안",
    evidenceSection: "증거 수집",
    retryEvidence: "증거 묶음 다시 모으기",
    shareSection: "복사·저장",
    shareHint:
      "문안과 증거 묶음을 함께 복사하거나 텍스트 파일로 저장해 개발자의 Discord에 직접 게시할 수 있습니다. 웹훅 전송이 실패해도 이 방법은 항상 쓸 수 있습니다.",
    copy: "제보문 복사",
    download: "텍스트 파일 저장",
    deliverySection: "Discord 웹훅 전송",
    deliveryHeading: "개발자 Discord로 보내기 (선택)",
  },
  draft: {
    section: "문제 설명",
    symptom: "어떤 문제가 있었나요?",
    symptomExample: "예: 승인 창이 계속 나타나고 채팅을 이어갈 수 없습니다.",
    expected: "기대한 동작 (선택)",
    actual: "실제 동작 (선택)",
    textSection: "제보 문안",
    text: "최종 제보 문안: 전송·복사·저장 전에 민감정보를 확인하고 편집해 주십시오.",
  },
  // The draft text the user reviews, then copies, saves or sends to the developer's Discord.
  report: {
    heading: "# Context Agent 문제 제보",
    createdAt: (time: string) => `작성 시각: ${time}`,
    userHeading: "## 사용자 설명 (AI 진단 아님)",
    symptom: (text: string) => `증상: ${text}`,
    expected: (text: string) => `기대한 동작: ${text}`,
    actual: (text: string) => `실제 동작: ${text}`,
    unwritten: "(작성하지 않음)",
    evidenceHeading: "## 증거 묶음 요약",
    noEvidence: "첨부된 증거 없음. 위 설명만으로 제보합니다.",
    evidenceFailed: "증거 묶음을 수집하지 못했습니다. 위 설명만으로 제보합니다.",
    attachment: (session: string, runs: number, runCount: number) =>
      `전체 내용: 첨부 context-agent-evidence.json (세션 #${session}, run ${runs}/${runCount}개)`,
    environment: ({ release, platform, runtime, provider, model }: ReportBundle["environment"]) =>
      `환경: ${release} · ${platform} · ${runtime} · 모델 ${provider ?? "?"}/${model ?? "?"}`,
    runError: (code: string) => `(오류 ${code})`,
    noCode: "코드 없음",
    failedTools: (calls: string) => `실패한 도구 ${calls}`,
    bundleHeading: "## 증거 묶음 (context-agent-evidence.json)",
    diagnosisSkipped: "AI 진단: 수행하지 않음",
    diagnosisFailed: (reason: string) =>
      `AI 진단: 실패 (${reason}). 이 제보는 사용자 설명과 증거 묶음뿐입니다.`,
    summaryHeading: "## AI 진단 요약 (사용자가 검토함)",
    observationsHeading: "## AI 진단: 관측 (증거 묶음에서 확인)",
    hypothesesHeading: "## AI 진단: 가설 (검증되지 않은 추정)",
    none: "없음",
  },
  diagnosis: {
    failure: {
      model_unavailable: "선택한 모델을 쓸 수 없습니다(로그인과 모델 선택을 확인해 주십시오)",
      model_failed: "모델 호출이 실패했거나 시간이 초과됐습니다",
      invalid_answer: "모델 응답을 진단 형식으로 읽지 못했습니다",
      request_failed: "진단 요청이 실패했습니다",
    } satisfies Record<ReportDiagnosisFailure | "request_failed", string>,
    request: "내 모델로 오류 진단·초안 만들기",
    requestHint:
      "작성한 설명과 아래 증거 묶음의 요약(타임라인과 실패 주변 원문)을 선택한 모델에 보냅니다. 진단 없이도 제보할 수 있습니다.",
    running: "진단 중입니다. 기다리는 동안에도 제보문을 복사·저장·전송할 수 있습니다.",
    failed: (reason: string) =>
      `진단 실패: ${reason}. 제보문에는 사용자 설명과 증거 묶음만 들어갑니다.`,
    retry: "다시 진단 받기",
    include: "제보문에 AI 진단 포함",
    summary: "요약 (개발자가 처음 읽는 부분)",
    observations: "관측 (증거 묶음에서 확인)",
    hypotheses: "가설 (검증되지 않음)",
    rerun: "다시 진단 받기 (편집 내용 삭제)",
    none: "없음",
    evidence: (ids: string) => `근거: ${ids}`,
    remove: "이 항목 빼기",
  },
  delivery: {
    failure: {
      not_configured: "이 서버에 개발자 웹훅이 설정되지 않았습니다",
      invalid_webhook_url: "서버에 설정된 웹훅 주소가 Discord 웹훅 형식이 아닙니다",
      too_large:
        "제보문이나 증거 묶음이 너무 큽니다. 문안을 줄이거나 복사·저장으로 게시해 주십시오",
      in_progress: "같은 제보문을 보내는 중입니다",
      rate_limited: "Discord가 잠시 요청을 막았습니다. 잠시 후 다시 시도해 주십시오",
      webhook_rejected:
        "Discord가 이 웹훅을 거부했습니다(삭제되거나 재발급됐을 수 있습니다). 개발자에게 알려 주십시오",
      payload_rejected: "Discord가 메시지 형식을 거부했습니다",
      discord_unavailable: "Discord에 연결할 수 없습니다",
      uncertain: "전송 확인을 받지 못했습니다. 채널에 이미 올라갔을 수 있습니다",
      request_failed: "로컬 서버 요청이 실패했습니다",
    } satisfies Record<ReportDeliveryFailure | "request_failed", string>,
    outcome: {
      sending: "Discord로 보내는 중입니다.",
      delivered: (messageId: string) => `개발자 Discord 채널로 보냈습니다 (메시지 ${messageId}).`,
      duplicate: (deliveredAt: string) => `이 문안은 ${deliveredAt}에 이미 보냈습니다.`,
      uncertainDuplicate: (attemptedAt: string) =>
        `이 문안의 이전 전송(${attemptedAt})은 확인되지 않았습니다. 채널을 확인한 뒤 필요하면 다시 보내 주십시오.`,
      failed: (reason: string) =>
        `보내지 못했습니다: ${reason}. 위의 복사·텍스트 파일 저장으로 직접 게시할 수 있습니다.`,
    },
    checking: "웹훅 설정을 확인하는 중입니다.",
    unavailable: {
      what: "웹훅 설정을 확인하지 못했습니다.",
      next: "복사·저장으로 직접 게시해 주십시오.",
    } satisfies ProblemCopy,
    notConfigured: {
      what: "이 서버에는 개발자 Discord 웹훅이 설정되지 않았습니다.",
      next: "복사·저장으로 직접 게시해 주십시오.",
    } satisfies ProblemCopy,
    configured: (webhookIdSuffix: string, withEvidence: boolean) =>
      `개발자 웹훅 …${webhookIdSuffix}. 위 최종 문안이 메시지로, ${withEvidence ? "증거 묶음 전체가 JSON 첨부 파일로" : "증거 묶음 없이"} 전송됩니다.`,
    defectReports:
      "앱에서 결함이 생기면 요약을 이 웹훅으로 자동 전송 (대화·프롬프트·자격증명은 보내지 않음)",
    send: "Discord로 보내기",
    resend: "그래도 다시 보내기",
  },
  bundle: {
    sections: {
      integrations: "MCP·외부 에이전트",
      loops: "백그라운드 루프",
      boards: "칸반 보드",
      defects: "최근 결함",
      timeline: "세션 타임라인",
      unlinked: "run 없는 항목",
    } satisfies Record<BundleSection, string>,
    gapFailed: (section: string) => `${section}: 수집 실패`,
    gapTruncated: (section: string) => `${section}: 오래된 항목은 상한 때문에 빠졌음`,
    emptyText: "(비어 있음)",
    textCut: "[상한에서 잘림]",
    user: "사용자",
    model: "모델",
    noName: "(이름 없음)",
    noResult: "결과 없음",
    failed: "실패",
    done: "완료",
    approval: (tool: string, status: string) => `승인 요청 ${tool}: ${status}`,
    unknownTool: "(도구 미상)",
    approved: "승인",
    rejected: "거부",
    traceFrom: (seq: number) => `(call-${seq}에서 시작)`,
    hasFailure: "실패 포함",
    eventCount: (count: number) => `${count}개`,
    runError: (code: string) => `run 오류 ${code}`,
    noCode: "(코드 없음)",
    failedSpans: "실패한 span",
    spanTotals: "시간을 쓴 곳 (span 합계)",
    spanTotalsCut: "짧게 걸린 span 경로는 빠졌습니다.",
    eventsCut: "앞부분 이벤트는 빠졌습니다.",
    section: "보낼 증거 묶음",
    heading: "보낼 증거 묶음 (읽기 전용)",
    note: "아래 내용 전체가 제보에 JSON 첨부 파일로 붙습니다. 비밀정보 탐지기로 가렸지만 놓친 값이 있을 수 있으니 보내기 전에 펼쳐서 확인해 주십시오.",
    summary: ({
      session,
      runs,
      runCount,
      failingRuns,
      cutTexts,
      kilobytes,
    }: {
      session: string;
      runs: number;
      runCount: number;
      failingRuns: number;
      cutTexts: number;
      kilobytes: string;
    }) =>
      `세션 #${session} · run ${runs}/${runCount}개 · 실패 포함 run ${failingRuns}개 · 잘린 원문 ${cutTexts}개 · 약 ${kilobytes}KB`,
    environment: "환경",
    version: "버전",
    notSelected: "(선택 없음)",
    concurrency: "칸반 동시 실행",
    defaultValue: "기본값",
    integrations: "연동·루프·결함",
    defectCount: (count: number) => `결함 ${count}`,
    agent: "에이전트",
    loop: (loop: string, health: string) => `루프 ${loop}: ${health}`,
    defect: (tag: string, location: string, count: number) => `결함 ${tag} @ ${location} ×${count}`,
    boards: (count: number) => `칸반 보드 (${count})`,
    board: (ref: string, status: string, health: string) =>
      `보드 #${ref} · ${status} · 루프 ${health}`,
    card: (card: string, failureStreak: number, replans: number) =>
      `${card}: 실패 ${failureStreak} · Plan 재작성 ${replans}`,
    timeline: (count: number) => `세션 타임라인 (run ${count})`,
    noRuns: "기록된 run이 없습니다.",
    unlinked: (count: number) => `run 없는 항목 (${count})`,
  },
};
