import type { Data } from "effect";
import type {
  ConfigFileFailureCode,
  McpFailureCode,
  McpLoginFailureCode,
  ScanFailure,
} from "memory-agent/definitions";
import type {
  AgentRole,
  CrossProviderMediaConsentMode,
  EmbeddingChoice,
  EmbeddingOverview,
  ImportActivity,
  SkillCatalog,
} from "../api";
import type { ProblemCopy } from "../shared/copy-templates";

/** Copy for the settings dialog and its pages. Checked by lint/wording. */
export const settingsCopy = {
  dialog: {
    title: "설정",
    description: "대화 밖에서 쓰는 도구와 연결을 관리합니다.",
    groups: {
      connection: "연결",
      memory: "기억",
      run: "실행",
      improvement: "개선",
      instructions: "지침",
    },
  },
  /** Each page's name, in the tab list and at the top of the page. */
  titles: {
    web: "웹 검색",
    image: "이미지 생성",
    mcp: "MCP 서버",
    agents: "외부 에이전트",
    conversation: "긴 대화",
    recall: "기억 범위",
    imports: "대화 가져오기",
    embedding: "임베딩",
    kanban: "칸반 실행",
    improvements: "프로젝트 개선",
    skills: "Skills",
  },
  shared: {
    save: "저장",
    changeFailed: "바꾸지 못했습니다.",
    settingsChangeFailed: "설정을 바꾸지 못했습니다.",
    keychainFailed: "OS 키체인에 접근하지 못했습니다. 키를 다른 곳에 대신 저장하지 않습니다.",
    kagiKeyRequired: "먼저 API 키를 등록해 주십시오.",
    noProject: "사이드바에서 프로젝트를 고르면 그 프로젝트의 설정이 보입니다.",
    pathCopied: "경로를 복사했습니다",
    copyPath: "전체 경로 복사",
    configFileFailure: {
      unreadable: "파일을 읽지 못했습니다.",
      invalid_config: "설정 형식이 맞지 않아 이 파일을 쓰지 않습니다.",
      invalid_names: "이름은 영문자·숫자·_·-로 1~32자여야 합니다. 맞지 않는 항목은 빼고 씁니다.",
    } satisfies Record<ConfigFileFailureCode, string>,
    scopes: { global: "공통", project: "프로젝트" },
    builtinScope: "기본",
    projectWins: "이름이 같으면 프로젝트 설정을 씁니다.",
    hiddenTarget: "비밀정보 확인에 실패해 명령줄을 숨겼습니다.",
    secretNames: (kind: string, names: string) => `${kind}: ${names} (값은 보여 주지 않습니다)`,
    secretKinds: { env: "환경 변수", headers: "헤더" },
    trust: { stop: "사용 중지", again: "다시 신뢰하기", first: "신뢰하기" },
    trustBadges: { untrusted: "신뢰 필요", changed: "설정 바뀜, 다시 신뢰 필요" },
    shadowed: "프로젝트 설정으로 대체됨",
  },
  agents: {
    description:
      "신뢰한 ACP 에이전트에게 모델이 작업을 맡길 수 있습니다. 맡길 때마다 승인합니다. 에이전트는 이 앱의 ChatGPT 로그인이 아니라 자기 로그인으로 일합니다.",
    link: {
      idle: "쓸 때 시작",
      connecting: "연결 중",
      connected: "연결됨",
      retrying: (failures: number) => `연결 실패 ${failures}회`,
      stopped: "재연결 중단",
    },
    stoppedProblem: (failure: string) =>
      `${failure} 두 번 연달아 실패해서 멈췄습니다. 다시 연결을 눌러 주십시오.`,
    empty: "설정된 에이전트가 없습니다.",
    reconnect: "다시 연결",
  },
  conversation: {
    description:
      "대화가 길어지면 앞쪽 턴을 요약으로 바꿔 보냅니다. 원문은 기억에 남아 있어서 모델이 필요할 때 다시 읽습니다.",
    startLabel: "요약 시작 시점 (컨텍스트 대비 %)",
    startHelp: (maximum: number) =>
      `모델 컨텍스트가 이만큼 찰 때까지는 원문 그대로 보냅니다. 낮추면 일찍 요약해 짧게 보냅니다. 높이면 원문을 오래 보냅니다. 0이면 처음부터 요약합니다. 최대 ${maximum}%입니다. 다음 응답부터 적용됩니다. 이미 요약을 쓰기 시작한 대화는 계속 요약을 씁니다.`,
  },
  embedding: {
    description:
      "기억을 뜻으로 찾을 때 쓰는 벡터를 어디서 만들지 정합니다. 사용자와 모델의 발언만 임베딩합니다. 도구 기록은 글자 검색으로 찾습니다.",
    choices: {
      auto: "자동",
      cpu: "CPU",
      gpu: "GPU (빠름)",
    } satisfies Record<EmbeddingChoice, string>,
    running: {
      notLoaded: (mode: string) => `${mode} 모드, 아직 불러오지 않음`,
      cpu: "CPU에서 실행 중",
      webgpu: "GPU(WebGPU)에서 실행 중",
      gpuOnCpu: "GPU 모드, CPU에서 실행 중",
    },
    runningNote: {
      notLoaded: "모델은 처음 임베딩할 때 불러옵니다.",
      gpuOnCpu:
        "WebGPU를 쓸 수 없어 지금은 CPU에서 GPU용 모델을 돌리고 있습니다. 벡터는 같지만 더 느립니다.",
    },
    downloads: {
      embedding: "임베딩 모델",
      rerank: "검색 결과 정렬 모델",
    } satisfies Record<EmbeddingOverview["downloads"][number]["purpose"], string>,
    downloading: (model: string) => `${model} 내려받는 중`,
    gpuUnavailable: {
      "no WebGPU device": "WebGPU 장치를 찾지 못했습니다.",
      worker_load_failed: "임베딩 worker가 모델을 불러오지 못했습니다.",
      worker_run_failed: "임베딩 worker가 시험 임베딩을 하지 못했습니다.",
      worker_lost_failed: "임베딩 worker가 응답 없이 끝났습니다.",
      embedding_failed: "시험 임베딩을 하지 못했습니다.",
    },
    gpuUnavailableOther: "확인 중 문제가 생겼습니다.",
    gpu: {
      unchecked: "아직 확인하지 않았습니다.",
      checking: "확인하는 중입니다. 처음 확인할 때는 GPU용 모델(약 570MB)을 내려받습니다.",
      available: (checkedAt: string) => `쓸 수 있습니다(${checkedAt} 확인).`,
      unavailable: (checkedAt: string, reason: string) =>
        `쓸 수 없습니다(${checkedAt} 확인): ${reason}`,
    },
    deviceLabel: "실행 방식",
    deviceHelp:
      "CPU는 벡터를 만드는 동안 코어를 여럿 씁니다. GPU는 CPU를 훨씬 덜 쓰고 다섯 배쯤 빠르며 메모리도 조금 덜 씁니다. 자동은 GPU와 같습니다. WebGPU를 쓸 수 없으면 같은 모델을 CPU에서 돌립니다.",
    restart: (mode: string) =>
      `앱을 다시 시작한 뒤에는 ${mode} 모드로 돌아갑니다. 그 모드로 만든 벡터가 없으면 처음부터 다시 만듭니다. 그동안에도 글자 검색과 형태소 검색은 됩니다.`,
    recheck: "다시 확인",
    /** Around an animated count of messages not embedded yet. */
    unindexed: { before: "아직", after: "개를 임베딩하지 않았습니다. 최근 대화부터 채웁니다." },
    maintenance: {
      title: "기억 그래프 정리",
      description:
        "이전 버전이 잘못 남긴 기억 연결을 자동으로 점검합니다. 원문과 정상 벡터는 보존하고 빈 응답의 의미 연결과 근거 연결 오류만 정리합니다. 정정과 취소 해석은 바꾸지 않습니다.",
      running: "저장된 기억을 점검하고 있습니다.",
      completed: (repaired: number, suppressed: number, retired: number) =>
        `근거 연결 ${repaired}개, 의미 연결 ${suppressed}개, 불필요한 주제 ${retired}개를 정리했습니다.`,
      scheduled: "저장된 기억을 자동으로 점검할 예정입니다.",
    },
  },
  image: {
    enabledFailed: "이미지 설정을 바꾸지 못했습니다.",
    consentFailed: "공급자 간 이미지 실행 동의를 바꾸지 못했습니다.",
    badge: { on: "사용 중", off: "꺼짐" },
    description:
      "이미지 생성이 필요할 때만 작성창에서 생성 모드를 선택해 사용합니다. 일반 대화에는 이미지 도구가 추가되지 않습니다.",
    enabledLabel: "이미지 생성 사용",
    enabledHelp:
      "OpenAI API 키가 필요하며 생성할 때마다 비용이 발생할 수 있습니다. 설정은 바로 적용되고 앱을 다시 시작할 필요가 없습니다.",
    notAutomatic:
      "켜도 이미지는 자동으로 생성되지 않습니다. 작성창에서 이미지 생성 모드를 선택한 요청만 처리합니다. 유료 실행 전에는 별도로 확인합니다.",
    crossProviderLabel: "Claude에서 이미지 생성",
    crossProviderHelp:
      "Claude 사용 중 이미지 생성을 요청하면 프롬프트를 OpenAI로 보냅니다. 사용량은 OpenAI 계정에 귀속됩니다. 로그인만으로 자동 허용되지 않습니다.",
    consentModes: {
      disabled: "사용 안 함",
      ask: "매번 확인",
      always: "항상 허용",
    } satisfies Record<CrossProviderMediaConsentMode, string>,
  },
  imports: {
    unplaced: {
      not_found: "폴더가 없어졌습니다",
      not_directory: "폴더가 아닙니다",
      overlaps_storage: "이 앱의 저장 폴더 안입니다",
      no_session_line: "어느 대화인지 알 수 없습니다",
      no_project: "프로젝트를 찾지 못했습니다",
    },
    failures: {
      PlatformError: "파일을 읽지 못했습니다",
      SchemaError: "기록 형식을 읽지 못했습니다",
      TranscriptDecompressFailed: "압축된 기록을 풀지 못했습니다",
      ImportStoreFailed: "기억 저장소에 쓰지 못했습니다",
      BulkWriteFailed: "기억 저장소에 쓰지 못했습니다",
      SqlError: "기억 저장소에 쓰지 못했습니다",
      Defect: "예상하지 못한 오류가 났습니다",
      Interrupted: "가져오기가 중단됐습니다",
    },
    platformFailures: {
      NotFound: "파일을 찾지 못했습니다",
      PermissionDenied: "파일을 읽을 권한이 없습니다",
    },
    failureOther: "가져오지 못했습니다",
    crashReasons: {
      start: "가져오기 작업을 시작하지 못했습니다",
      count: "기록 수를 세지 못했습니다",
      pass: "기록을 읽다가 실패했습니다",
      lost: "가져오기 작업이 끊겼습니다",
    } satisfies Record<Data.TaggedEnum.Value<ImportActivity, "crashed">["reason"], string>,
    /** The running pass, around animated counts: checked/total, then nodes written. */
    running: {
      reading: "기록을 읽는 중입니다.",
      checked: "개를 확인하고 노드",
      written: "개를 더했습니다.",
    },
    /** After an animated count of transcripts that could not be read. */
    unreadAfter: "개는 읽지 못했습니다.",
    unread: (count: number) => `${count}개는 읽지 못했습니다.`,
    finished: (time: string, checked: number, written: number) =>
      `${time}에 기록 ${checked}개를 확인하고 노드 ${written}개를 더했습니다.`,
    crashed: (time: string, reason: string) => `${time}에 가져오기가 중간에 멈췄습니다: ${reason}`,
    description:
      "Claude Code와 Codex CLI가 이 컴퓨터에 남긴 대화를 기억으로 옮깁니다. 도구 호출과 결과까지 옮겨서 옛 대화도 근거를 따라갈 수 있습니다. 원본 파일은 읽기만 합니다.",
    reading: "읽는 중",
    importNow: "지금 가져오기",
    keepImportingLabel: "계속 가져오기",
    keepImportingHelp:
      "5분마다 새로 쌓인 대화를 이어서 읽습니다. 켤 때 지금 있는 기록을 한 번 읽습니다.",
    watch: "감시",
    interpretLabel: "가져온 발언도 해석",
    interpretHelp:
      "주제를 붙이고 정정, 취소 관계를 정리합니다. 모델을 쓰기 때문에 답변이 끝난 뒤 조금씩 처리됩니다.",
    /** A source's totals, around animated counts: transcripts, migrated, then nodes. */
    source: {
      transcripts: "기록",
      migrated: "개 중",
      nodes: "개를 읽어 노드",
      written: "개를 넣었습니다.",
    },
    /** Around an animated count of nodes still being indexed. */
    unindexed: {
      before: "아직",
      after:
        "개를 인덱싱하고 있습니다. 최근 대화부터 채웁니다. 그동안에도 글자 검색과 형태소 검색으로는 찾을 수 있습니다.",
    },
    projectsNote:
      "대화가 있던 폴더는 프로젝트로 등록됩니다. 에이전트가 그 폴더의 파일을 읽고 고칠 수 있게 됩니다. 필요 없는 프로젝트는 사이드바에서 목록에서 빼 주십시오.",
    unplacedTitle: "아래 폴더는 프로젝트로 만들 수 없어 가져오지 않았습니다.",
    unplacedFolder: (cwd: string, transcripts: number, reason: string) =>
      `${cwd}: 대화 ${transcripts}개, ${reason}`,
    failuresTitle: "아래 기록은 읽지 못했습니다. 다음에 읽을 때 다시 시도합니다.",
  },
  improvements: {
    failures: {
      storage: "프로젝트 사용 기록을 읽지 못했습니다.",
      report: "개선 문서를 쓰거나 읽지 못했습니다.",
      embedding: "임베딩 모델로 비슷한 정정을 묶지 못했습니다. 임베딩 설정을 확인해 주십시오.",
      model_unavailable:
        "개선 항목을 해석할 모델이 없습니다. 채팅에서 모델을 고르고 로그인한 뒤 다시 시도해 주십시오.",
      model_unreachable:
        "모델 서버가 응답하지 않아 찾기를 멈췄습니다. 모델 서버 연결을 확인한 뒤 다시 시도해 주십시오.",
      internal: "개선 항목을 찾는 중 오류가 났습니다. 다시 시도해 주십시오.",
    } satisfies Record<ScanFailure, string>,
    collecting: "사용 기록에서 신호를 모으는 중입니다.",
    progress: (
      repositoriesDone: number,
      repositoriesTotal: number,
      itemsDone: number,
      itemsTotal: number,
    ) =>
      `찾는 중입니다. 저장소 ${repositoriesDone}/${repositoriesTotal} · 해석한 항목 ${itemsDone}/${itemsTotal}`,
    stopped: "찾기를 중지했습니다. 이전 결과는 그대로입니다.",
    rule: (rule: string) => `지침: ${rule}`,
    ruleFailed: "모델이 해석하지 못했습니다. 문서의 근거를 직접 확인해 주십시오.",
    unsupported: {
      what: "실행 중인 서버가 프로젝트 개선을 지원하지 않습니다.",
      next: "앱 서버를 재시작한 뒤 다시 시도해 주십시오.",
    } satisfies ProblemCopy,
    requestFailed: "요청을 처리하지 못했습니다.",
    itemCount: (count: number) => `${count}개 항목`,
    occurrences: (count: number) => `${count}회`,
    noItems: "반복된 정정이나 실패가 없어 고칠 항목이 없습니다.",
    showDocument: "작업 명세 문서 보기",
    copied: "복사했습니다",
    copyDocument: "문서 복사",
    description:
      "열린 프로젝트의 최근 90일 사용 기록에서 반복된 정정과 실패를 찾아 저장소마다 고칠 항목과 작업 명세를 문서로 남깁니다. 코드와 에이전트 지침을 함께 고치는 명세입니다. 앱은 저장소를 직접 바꾸지 않습니다.",
    stop: "중지",
    find: "개선 항목 찾기",
    findAgain: "다시 찾기",
    loading: "기록한 개선 항목을 불러오는 중입니다.",
    neverScanned: "아직 개선 항목을 찾은 적이 없습니다.",
    foundAt: (time: string) => `${time}에 찾은 결과입니다.`,
    noRepositories: "git 저장소인 열린 프로젝트가 없습니다.",
  },
  kanban: {
    description:
      "Goal을 칸반 보드로 실행할 때 쓰는 값을 정합니다. 함께 돌릴 카드 수, Plan 작성·실행·검증에 쓸 모델, 끝난 Goal을 자동으로 merge할 브랜치입니다.",
    errors: {
      invalidSettings:
        "값이 올바르지 않습니다. 동시 실행 수는 1~32, 브랜치 이름은 영문·숫자·._/-만 쓸 수 있습니다.",
      projectNotFound: "프로젝트를 찾을 수 없습니다.",
      roleModelUnavailable: {
        what: "이 모델을 쓸 수 없습니다.",
        next: "그 제공자 로그인 상태와 모델, 추론 단계가 맞는지 확인해 주십시오.",
      } satisfies ProblemCopy,
      saveFailed: {
        what: "설정을 저장하지 못했습니다.",
        next: "잠시 뒤 다시 시도해 주십시오.",
      } satisfies ProblemCopy,
    },
    concurrencyLabel: "동시에 실행할 카드 수",
    useDefault: "기본값으로",
    deviceDefault: "(기기 기본값: CPU 코어 절반, 1~4개)",
    concurrencyHelp: (effective: number, deviceDefault: string) =>
      `모든 Goal의 카드를 합쳐 이만큼만 동시에 실행합니다. 지금 ${effective}개${deviceDefault}로 실행합니다. 저장하면 바로 적용됩니다. 실행 중인 카드는 멈추지 않습니다. 빈 슬롯은 아래 프로젝트 순서, 그 안에서는 칸반 보드의 대화 순서대로 줍니다.`,
    projectOrder: "프로젝트 순서",
    moveUp: (project: string) => `${project} 위로`,
    moveDown: (project: string) => `${project} 아래로`,
    projectOrderHelp:
      "위 프로젝트의 카드부터 실행합니다. 한 프로젝트 안에서는 칸반 보드의 대화 순서를 따릅니다.",
    /** What each role of a Goal does. */
    roles: {
      planner: {
        label: "Plan 작성자 모델",
        description:
          "Goal을 붙잡고 다음 Plan을 쓰는 대화의 모델입니다. 칸반 보드로 실행 중인 대화에 쓰입니다.",
      },
      executor: {
        label: "실행자 모델",
        description: "카드 하나를 맡아 그 카드의 worktree에서 작업하는 카드 에이전트의 모델입니다.",
      },
      verifier: {
        label: "검증자 모델",
        description: "끝난 카드와 merge 전 Goal 브랜치를 고치지 않고 판정만 하는 모델입니다.",
      },
    } satisfies Record<AgentRole, { readonly label: string; readonly description: string }>,
    selectedModel: "선택된 모델",
    modelSelect: (role: string) => `${role}: 모델`,
    modelPlaceholder: "모델 고르기",
    effortSelect: (role: string) => `${role}: 추론 단계`,
    runsSelected: "지금은 선택된 모델로 실행합니다.",
    runsOn: (provider: string, model: string, effort: string) =>
      `지금은 ${provider} / ${model} (${effort})로 실행합니다.`,
    appliesNextRun: "저장하면 다음 실행부터 적용됩니다.",
    modelsFailed: {
      what: "모델 목록을 읽지 못했습니다.",
      next: "그 제공자에 로그인했는지 확인해 주십시오.",
    } satisfies ProblemCopy,
    protectedBranches: (project: string) => `보호 브랜치 (${project})`,
    protectedBranchesHelp:
      "Goal을 시작한 브랜치가 여기 있으면 카드가 모두 끝나도 자동으로 merge하지 않습니다. 대신 PR을 만들지 직접 merge할지 묻습니다. 쉼표로 구분합니다. 비우면 모든 브랜치에 자동으로 merge합니다.",
    protectedBranchesNoProject:
      "보호 브랜치는 프로젝트마다 정합니다. 프로젝트를 고른 뒤 다시 열어 주십시오.",
  },
  mcp: {
    description:
      "신뢰한 서버만 시작합니다. 설정 파일이 바뀌면 다시 신뢰해야 합니다. 신뢰해도 도구를 부를 때마다 승인이나 자동 판단을 거칩니다.",
    state: {
      trusted: "다음 대화에서 시작",
      connected: (tools: number) => `도구 ${tools}개`,
      failed: "시작 실패",
      needsLogin: "로그인 필요",
      loggingIn: "브라우저에서 로그인 중",
    },
    failures: {
      missing_env: "설정이 쓰는 환경 변수가 없습니다.",
      connect_timed_out: "서버가 제시간에 연결되지 않았습니다.",
      tools_list_timed_out: "서버가 제시간에 도구 목록을 주지 않았습니다.",
      start_failed: "서버를 시작하거나 연결하지 못했습니다.",
    } satisfies Record<McpFailureCode, string>,
    loginFailures: {
      callback_port_unavailable:
        "로그인 후 돌아올 포트를 열지 못했습니다. 다른 프로그램이 쓰고 있을 수 있습니다.",
      login_timed_out: "로그인이 제시간에 끝나지 않았습니다.",
      login_denied: "로그인이 거절됐습니다.",
      login_failed: "로그인하지 못했습니다.",
    } satisfies Record<McpLoginFailureCode, string>,
    empty: "설정된 MCP 서버가 없습니다.",
    loginInBrowser: "브라우저에서 로그인",
    cancelLogin: "로그인 취소",
    loginAgain: "다시 로그인",
    login: "로그인",
    logout: "로그아웃",
  },
  recall: {
    description:
      "대화가 지금 프로젝트 밖의 기억을 쓰거나 내보낼지 정합니다. 둘 다 처음에는 꺼져 있습니다.",
    crossProjectLabel: "다른 프로젝트 기억도 찾기",
    crossProjectHelp:
      "켜면 다른 프로젝트의 대화도 함께 찾습니다. 사이드바에서 다른 프로젝트 검색을 막아 둔 프로젝트는 제외됩니다.",
    externalAgentLabel: "외부 에이전트에 기억 보내기",
    externalAgentHelp:
      "외부 에이전트와 직접 대화할 때, 메시지와 관련된 기억을 최대 5개까지 출처와 함께 메시지 앞에 붙여 보냅니다. 외부 프로세스로 나가는 내용이라 필요할 때만 켜 주십시오.",
  },
  skills: {
    problems: {
      no_description: "description이 없어 쓰지 않습니다.",
      too_large: "SKILL.md가 너무 커서 쓰지 않습니다.",
      unreadable: "읽지 못했습니다.",
    } satisfies Record<SkillCatalog["problems"][number]["problem"], string>,
    description:
      "모델이 이름과 설명을 보고 작업에 맞는 skill을 읽어 따릅니다. skill은 지침일 뿐이라 승인을 대신하지 않습니다.",
    count: (count: number) => `${count}개`,
    sourceNote:
      "이름이 같으면 프로젝트, 공통, 기본 순으로 앞의 것을 씁니다. 기본 skill도 같은 이름으로 덮어쓸 수 있습니다.",
    empty: "쓸 수 있는 skill이 없습니다.",
  },
  web: {
    badge: { on: "켜짐", off: "꺼짐", noKey: "키 없음" },
    description:
      "켜면 모델이 필요할 때 Kagi로 웹을 검색하고 페이지를 읽습니다. 모든 프로젝트에 적용됩니다. 호출마다 Kagi 요금이 나갑니다.",
    enabledLabel: "검색과 페이지 읽기 사용",
    enabledHelp: "실패해도 다시 시도하지 않습니다. 끄면 다음 호출부터 바로 막힙니다.",
    keyTitle: "API 키",
    keyStored: "OS 키체인에 저장돼 있습니다. 화면에 다시 보여 주지 않습니다.",
    deleteKey: "키 삭제",
    keyPlaceholder: "kagi.com/api/keys에서 발급한 키",
    keyHelp:
      "키는 OS 키체인에만 저장되고 모델, 대화, 로그에는 보이지 않습니다. 저장해도 저절로 켜지지는 않습니다.",
  },
};
