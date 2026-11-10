import type {
  AgentFailureCode,
  CardRisk,
  VerdictFailure,
  WorktreeFailureReason,
} from "memory-agent";
import type { CardStatus } from "../../api";
import type { ConfirmCopy, ProblemCopy } from "../../shared/copy-templates";

/** Copy for the kanban board. Checked by lint/wording. */
export const boardCopy = {
  status: {
    backlog: "백로그",
    ready: "준비",
    in_progress: "진행 중",
    verify: "검증",
    human_decision: "판단 필요",
    done: "완료",
    blocked: "막힘",
  } satisfies Readonly<Record<CardStatus, string>>,
  drop: {
    orchestratorMoves: (column: string) => `${column} 열은 오케스트레이터가 옮깁니다.`,
    orchestratorAsks: "판단 요청은 오케스트레이터가 만듭니다.",
    orchestratorBlocks: "막힘은 오케스트레이터가 표시합니다.",
    holdFromReadyOnly: "준비 카드만 백로그로 보류할 수 있습니다.",
    readyFromHeldOrBlocked: "보류했거나 막힌 카드만 준비로 옮길 수 있습니다.",
    needsKanban: "칸반으로 실행할 때만 보류하거나 다시 대기열에 넣을 수 있습니다.",
    planClosed: "완료된 Plan은 바꿀 수 없습니다.",
    decisionCard: "판단 필요 카드는 판단에 답하면 옮겨집니다.",
    verifyCard: "검증 중인 카드는 오케스트레이터가 옮깁니다.",
    doneCard: "완료된 카드는 옮길 수 없습니다.",
    dependenciesPending: "의존 카드가 아직 끝나지 않았습니다.",
    blockedToReadyOnly: "막힌 카드는 준비 열로만 옮길 수 있습니다.",
    foreignCard:
      "다른 대화의 카드와는 순서를 바꿀 수 없습니다. 대화 순서는 대화별 상태 패널에서 바꿉니다.",
  },
  verdict: {
    Rejected: "검증에서 통과하지 못했습니다",
    NoVerdict: "검증이 판정을 남기지 않았습니다",
    NotFinished: "검증이 끝나지 않았습니다",
    ModelSelectionRequired: "검증할 모델이 선택되지 않았습니다",
    Unavailable: "검증을 실행할 수 없었습니다",
  } satisfies Readonly<Record<VerdictFailure["_tag"], string>>,
  agentFailure: {
    model_selection_required: "실행할 모델이 선택되지 않았습니다",
    not_started: "에이전트가 시작하지 못했습니다",
    failed: "에이전트 실행이 실패했습니다",
    cancelled: "에이전트 실행이 중단됐습니다",
    unavailable: "에이전트를 실행할 수 없었습니다",
  } satisfies Readonly<Record<AgentFailureCode, string>>,
  /** Worktree failures with their own words; the rest share `failure.Worktree`. */
  worktreeFailure: {
    WorktreeDirty: "카드 작업 폴더에 정리되지 않은 변경이 있습니다",
    InUse: "카드 작업 폴더를 다른 실행이 쓰고 있습니다",
    GitFailed: "git 명령이 실패했습니다",
  } satisfies Readonly<Partial<Record<typeof WorktreeFailureReason.Type, string>>>,
  failure: {
    Worktree: "카드 작업 폴더를 준비하지 못했습니다",
    GoalBranchKeptMoving: "Goal 브랜치가 계속 바뀌어 통합하지 못했습니다",
    Defect: "예상하지 못한 오류로 실패했습니다",
  },
  holdReason: {
    RetryBackoff: (failure: string) => `다시 실패해 잠시 뒤 재시도합니다: ${failure}`,
    ReplanRequested: "새 카드로 대체하도록 요청했습니다",
    ReplanAfterFailure: (failure: string) => `계속 실패해 카드를 다시 짭니다: ${failure}`,
    RepeatedFailure: (failure: string) => `다시 짠 뒤에도 실패했습니다: ${failure}`,
    MergeConflict: (files: string) => `Goal 브랜치와 충돌: ${files}`,
    UncertainEffect: "이전 실행의 결과를 알 수 없어 확인이 필요합니다",
    DeadLettered: "실행 기회를 모두 써서 멈췄습니다. 다시 대기열에 넣을 수 있습니다",
    GoalChanged: "Goal이 바뀌어 오케스트레이터가 이 카드를 멈췄습니다",
    UpstreamRegressed: (verdict: string) =>
      `다른 Goal이 merge된 뒤 다시 검증하니 통과하지 못했습니다: ${verdict}`,
  },
  /** What switching an executing Plan to the board changes, for the button's tooltip. */
  kanbanSwitchHint:
    "카드마다 에이전트를 따로 두고 보드가 배정·검증·통합합니다. 이 대화의 모델은 카드를 직접 실행하지 않습니다.",
  /** Why the board stopped waking its planner, for the badge's tooltip. */
  plannerStalledHint:
    "Plan 작성자가 연속으로 카드를 고쳤지만 새로 충족된 결과가 없어 자동 Plan 작성을 멈췄습니다. 이미 맡은 카드는 계속 실행됩니다. 대화에서 방향을 알려 주면 다시 Plan을 짭니다.",
  errors: {
    plan_version_conflict: {
      what: "그사이 Plan이 바뀌었습니다.",
      next: "최신 보드를 다시 확인해 주십시오.",
    } satisfies ProblemCopy,
    plan_dependencies_rejected: {
      what: "의존 관계가 올바르지 않습니다.",
      next: "없는 카드나 순환 의존을 확인해 주십시오.",
    } satisfies ProblemCopy,
    plan_outcomes_rejected: {
      what: "카드가 지금 Goal에 없는 결과를 가리킵니다.",
      next: "최신 Goal을 다시 확인해 주십시오.",
    } satisfies ProblemCopy,
    card_finished: "완료된 카드는 수정하거나 취소할 수 없습니다.",
    card_missing: "카드를 찾을 수 없습니다.",
    card_status_changed: {
      what: "그사이 카드가 옮겨졌습니다.",
      next: "최신 보드를 다시 확인해 주십시오.",
    } satisfies ProblemCopy,
    card_transition_invalid: "이 열로는 옮길 수 없습니다.",
    card_not_waiting: "시작하지 않은 카드만 보류할 수 있습니다.",
    card_held: "이미 보류한 카드입니다.",
    card_not_held: "보류하지 않은 카드입니다.",
    card_not_pending: "승인을 기다리는 카드가 아닙니다.",
    card_not_blocked: "막힌 카드만 다시 대기열에 넣을 수 있습니다.",
    card_not_running: "진행 중인 카드에만 수정 요청을 남길 수 있습니다.",
    card_running: {
      what: "진행 중인 카드는 다른 대화로 옮길 수 없습니다.",
      next: "끝나거나 멈춘 뒤에 옮겨 주십시오.",
    } satisfies ProblemCopy,
    card_waiting: "판단을 기다리는 카드는 판단에 답한 뒤에 옮길 수 있습니다.",
    card_has_dependents: {
      what: "이 카드를 기다리는 카드가 있어서 옮길 수 없습니다.",
      next: "그 카드의 의존을 먼저 풀어 주십시오.",
    } satisfies ProblemCopy,
    transfer_target_invalid: "같은 프로젝트에서 Plan이 있는 다른 대화로만 옮길 수 있습니다.",
    not_worktree: "카드를 프로젝트에서 차례로 실행하는 보드이므로 옮길 Goal 브랜치가 없습니다.",
    merge_started: "merge를 시작한 Goal은 대상 브랜치를 바꿀 수 없습니다.",
    detached_head: {
      what: "프로젝트에 checkout한 브랜치가 없습니다(detached HEAD).",
      next: "브랜치를 checkout한 뒤 다시 시도해 주십시오.",
    } satisfies ProblemCopy,
    goal_has_work:
      "Goal 브랜치에 두 브랜치 어디에도 없는 커밋이 있어 대상 브랜치를 바꿀 수 없습니다.",
    cards_started:
      "이 Goal의 카드 브랜치(취소한 카드 것 포함)가 남아 있어 대상 브랜치를 바꿀 수 없습니다.",
    reorder_across_columns: "순서는 같은 열 안에서만 바꿀 수 있습니다.",
    not_kanban: "칸반으로 실행할 때만 열을 옮길 수 있습니다.",
    plan_closed: "완료했거나 닫은 Plan은 바꿀 수 없습니다.",
    session_in_use: "다른 창에서 이 대화를 쓰고 있습니다.",
    plan_not_executing: "실행 중인 Plan만 칸반으로 돌릴 수 있습니다.",
    worktree_unavailable: "카드 작업 폴더를 만들 수 없습니다.",
    dependency_cycle: "서로 기다리는 Goal이 생겨서 지정할 수 없습니다.",
    /** goal_missing, other_project and self_dependency. */
    goal_unwaitable: "기다릴 수 없는 Goal입니다.",
    queue_item_changed: {
      what: "그사이 카드의 대기열 상태가 바뀌었습니다.",
      next: "최신 보드를 다시 확인해 주십시오.",
    } satisfies ProblemCopy,
    worktree_in_use: {
      what: "카드 작업 폴더를 다른 실행이 쓰고 있습니다.",
      next: "잠시 뒤 다시 시도해 주십시오.",
    } satisfies ProblemCopy,
    worktree_failed: "카드 작업 폴더를 정리하지 못했습니다.",
    /** Every storage failure code. */
    storage_failed: {
      what: "보드를 저장하거나 읽지 못했습니다.",
      next: "잠시 뒤 다시 시도해 주십시오.",
    } satisfies ProblemCopy,
    /** Any other failure. */
    unknown: "보드를 바꾸지 못했습니다.",
  },
  askChange: {
    title: "진행 중인 카드입니다",
    body: "진행 중인 카드는 오케스트레이터가 옮깁니다. 바꾸고 싶은 내용을 수정 요청으로 남기면 오케스트레이터가 반영할지 정합니다.",
    choices: { keep: "그대로 두기", request: "수정 요청 남기기" },
  } satisfies ConfirmCopy<"keep" | "request">,
  /** Same shape as ConfirmCopy, with the body naming the card and the conversation. */
  transfer: {
    title: "다른 대화로 옮길까요?",
    body: (card: string, conversation: string) =>
      `"${card}" 카드가 "${conversation}" 대화 Plan의 마지막에 새 카드로 들어갑니다. 의존은 끊기고 처음부터 다시 시작합니다. 지금까지의 작업은 이 카드의 브랜치에 남습니다.`,
    choices: { keep: "그대로 두기", move: "옮기기" },
  },
  risk: {
    low: "위험 낮음",
    medium: "위험 보통",
    high: "위험 높음",
  } satisfies Readonly<Record<CardRisk, string>>,
  author: { User: "사용자", Orchestrator: "오케스트레이터" },
  lastChange: {
    label: "마지막 변경",
    none: "기록 없음",
    byUser: (time: string) => `마지막 변경: 사용자 · ${time}`,
  },
  cardFace: {
    decisionPending: "판단 대기",
    held: "보류",
    approvalPending: "승인 대기",
    requesting: "요청 중",
    changePending: "변경 요청 대기",
    waitingOn: (count: number) => `선행 ${count}`,
  },
  peek: {
    missing: { title: "카드를 찾을 수 없습니다", body: "취소됐거나 다른 카드로 바뀌었습니다." },
    approval: {
      waiting:
        "Plan 작성자가 실행 중에 더한 카드라 승인을 기다립니다. 승인하기 전에는 실행하지 않습니다.",
      review: (reason: string) => `자동 검토: ${reason}`,
      rejectHint: "거절하려면 편집에서 카드를 취소해 주십시오.",
      approve: "승인",
    },
    hold: {
      reason: (reason: string) => `사유: ${reason}`,
      note: (note: string) => `검증 의견: ${note}`,
      changePending: "오케스트레이터가 이 카드의 변경 요청을 확인하고 있습니다.",
      requeue: "다시 대기열에",
    },
    transfer: {
      label: "다른 대화로 옮기기",
      target: "옮길 대화",
      placeholder: "대화 선택",
      submit: "옮기기",
      hint: "그 대화 Plan의 새 카드로 들어갑니다. 의존은 끊기고 처음부터 다시 시작합니다.",
    },
    actions: { hold: "보류", release: "보류 해제", edit: "편집", requestChange: "수정 요청" },
    details: {
      none: "없음",
      dependsOn: "의존",
      acceptanceCriteria: "완료 조건",
      outcomes: "Goal 결과",
      outcomeMissing: "지금 Goal에는 없는 결과입니다.",
      boundaries: "경계",
      risk: "위험",
      requiredEvidence: "필요한 근거",
      evidence: "남긴 근거",
      humanDecision: "사람 판단",
    },
  },
  editor: {
    newTitle: "카드 추가",
    newHint: "저장하면 보드에 바로 반영되고 작성자가 사용자로 남습니다.",
    executingHint:
      "진행 중인 카드라 바로 바뀌지 않습니다. 변경 요청으로 저장되고 오케스트레이터가 반영할지 정합니다.",
    title: "제목",
    description: "설명",
    dependsOn: "의존 카드",
    dependsOnHint: "카드 id를 쉼표로 구분합니다.",
    acceptanceCriteria: "완료 조건",
    onePerLine: "한 줄에 하나씩 적습니다.",
    boundaries: "경계",
    risk: "위험",
    riskNone: "지정 안 함",
    requiredEvidence: "필요한 근거",
    humanDecision: "사람 판단",
    close: "닫기",
    save: "저장",
    requestChange: "변경 요청",
    cancelCard: {
      trigger: "카드 취소",
      title: "이 카드를 취소할까요?",
      executing: "실행 중인 Plan이라 오케스트레이터가 확인한 뒤 취소됩니다.",
      waiting: "취소한 카드는 실행되지 않습니다.",
      choices: { keep: "그만두기", cancel: "카드 취소" },
    },
  },
  kanban: {
    label: "칸반 보드",
    instructions:
      "카드를 옮기려면 스페이스나 엔터를 눌러 집은 뒤 화살표 키로 옮기고 스페이스나 엔터로 놓습니다. Esc를 누르면 취소합니다.",
    /** What a drop on another column asks the server for, said while dragging over it. */
    send: {
      Hold: (card: string) => `${card} 카드를 보류합니다.`,
      Release: (card: string) => `${card} 카드의 보류를 풉니다.`,
      Requeue: (card: string) => `${card} 카드를 다시 대기열에 넣습니다.`,
    } satisfies Readonly<Record<"Hold" | "Release" | "Requeue", (card: string) => string>>,
    /** The same, as the column's hint. */
    sendHint: {
      Hold: "놓으면 보류합니다.",
      Release: "놓으면 보류를 풉니다.",
      Requeue: "놓으면 다시 대기열에 넣습니다.",
    } satisfies Readonly<Record<"Hold" | "Release" | "Requeue", string>>,
    askChangeHint: "놓으면 수정 요청을 남길지 묻습니다.",
    outside: (card: string) => `${card} 카드가 놓을 곳 밖에 있습니다.`,
    inColumn: (card: string, column: string) => `${card} 카드가 ${column} 열 안에 있습니다.`,
    askChange: (card: string) =>
      `${card} 카드는 진행 중이라 옮기지 않고 수정 요청을 남길 수 있습니다.`,
    refused: (column: string, reason: string) => `${column} 열에는 놓을 수 없습니다. ${reason}`,
    pickedUp: (card: string) => `${card} 카드를 집었습니다.`,
    putBack: (card: string) => `${card} 카드를 제자리에 두었습니다.`,
    dropped: (card: string, where: string) => `${card} 카드를 놓았습니다. ${where}`,
    cancelled: (card: string) => `${card} 카드 옮기기를 취소했습니다.`,
    columnFolded: (column: string, count: number) => `${column} ${count}개, 접힘`,
    column: (column: string, count: number) => `${column} ${count}개`,
    expand: (column: string) => `${column} 열 펼치기`,
    collapse: (column: string) => `${column} 열 접기`,
    grip: (card: string) => `${card} 옮기기`,
  },
  shortcuts: {
    label: "키보드 단축키",
    /** After the j, k, h and l keys. */
    moveFocus: "또는 화살표: 카드 사이 이동",
    /** After the Enter key. */
    open: ": 카드 열기",
    /** Before the first Space key. */
    pickUpAt: "손잡이에서",
    /** Between the two Space keys. */
    pickUp: ": 카드 집기, 화살표로 옮긴 뒤",
    /** After the second Space key. */
    drop: "로 놓기",
    /** After the Esc key. */
    cancel: ": 옮기기 취소",
  },
  project: {
    title: "프로젝트 칸반 보드",
    untitled: "제목 없는 대화",
    conversations: "실행 중인 대화",
    kanbanRunning: "칸반 실행",
    done: "완료",
    decisions: (count: number) => `판단 대기 ${count}`,
    notExecuting: (count: number) => `실행 중이 아닌 Plan ${count}개:`,
    allConversations: "모든 대화",
    shownConversations: "보이는 대화",
    order: "대화 순서와 상태",
    orderHint: "위쪽 대화의 카드부터 시작합니다. 카드 순서는 같은 대화 안에서 바꿉니다.",
    loading: "보드를 불러오는 중입니다.",
    empty: "실행 중인 Plan이 없습니다. 대화에서 Plan을 실행하면 보드에 올라옵니다.",
  },
  conversation: {
    region: (title: string) => `${title} 대화`,
    up: (title: string) => `${title} 위로`,
    down: (title: string) => `${title} 아래로`,
    kanbanRunning: "칸반 실행 중",
    plannerStalled: "자동 Plan 작성 멈춤",
    loop: "보드 루프",
    done: (done: number, total: number) => `완료 ${done}/${total}`,
    decisions: (count: number) => `판단 대기 ${count}`,
    pendingChanges: (count: number) => `변경 요청 대기 ${count}`,
    startKanban: "칸반으로 전환",
    addCard: "카드 추가",
    open: "대화 열기",
  },
};
