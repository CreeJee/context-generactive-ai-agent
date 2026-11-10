import type { ProblemCopy } from "./shared/copy-templates";

/** Copy for the app shell (sidebar, first-run placeholders) and the API error messages. Checked by tools/copy-check. */
export const entryCopy = {
  sidebar: {
    open: "사이드바 펼치기",
    openHint: "사이드바 펼치기 (⌘B)",
    close: "사이드바 접기",
    closeHint: "사이드바 접기 (⌘B)",
    toggle: "사이드바 접기·펼치기",
    toggleHint: "사이드바 접기·펼치기 (⌘B)",
    settings: "설정",
  },
  pendingLifecycle: {
    waitingForStop: "실행이 멈추기를 기다리고 있습니다. 아직 대화를 바꾸지 않았습니다.",
    goalDependents: {
      what: "다른 Goal 보드가 이 대화의 Goal이 merge되기를 기다리고 있습니다.",
      next: "그 보드에서 의존을 먼저 풀어 주십시오.",
    } satisfies ProblemCopy,
    blocked: {
      what: "지금은 대화를 바꿀 수 없습니다.",
      next: "실행 상태를 확인한 뒤 다시 시도해 주십시오.",
    } satisfies ProblemCopy,
  },
  switchAccountFailed: {
    what: "계정을 바꾸지 못했습니다.",
    next: "연결 상태를 확인한 뒤 다시 시도해 주십시오.",
  } satisfies ProblemCopy,
  currentEffort: (label: string) => `${label} (현재)`,
  placeholder: {
    connectProvider: {
      title: "공급자를 연결해 주십시오",
      description: "왼쪽에서 OpenAI 호환 공급자를 설정하거나 구독 계정에 로그인해 주십시오.",
    },
    selectModel: {
      title: "모델을 선택해 주십시오",
      description: "계정에서 쓸 수 있는 모델 중 하나를 골라 주십시오.",
    },
    setUpCompatible: "호환 공급자를 설정해 주십시오",
    signIn: "선택한 공급자에 로그인해 주십시오",
    connectionNeeded: (provider: string) => `${provider} 연결이 필요합니다.`,
    addProject: {
      title: "프로젝트를 추가해 주십시오",
      description: "대화와 기억은 프로젝트 단위로 저장됩니다.",
    },
    newSession: {
      title: "새 대화를 시작해 주십시오",
      description: "왼쪽의 새 대화 버튼을 눌러 주십시오.",
    },
  },
  accountModel: {
    signInHint: (provider: string) => `${provider} 계정을 연결하면 모델을 고를 수 있습니다.`,
    connect: "계정 연결",
  },
  accounts: {
    title: "계정 관리",
    description:
      "계정을 추가하고 계정마다 이름을 바꾸거나 로그아웃합니다. 쓸 계정은 사이드바 아래 계정 전환에서 고릅니다.",
  },
  attachment: {
    rejections: {
      too_large: "20MB보다 큰 이미지는 올릴 수 없습니다.",
      unsupported_type: "PNG, JPEG, GIF, WebP 이미지만 올릴 수 있습니다.",
      empty: "빈 파일입니다.",
    },
    failed: "이미지를 올리지 못했습니다.",
  },
  project: {
    rejections: {
      not_found: "경로를 찾을 수 없습니다.",
      not_directory: "폴더 경로가 아닙니다.",
      overlaps_storage: "앱 저장소 폴더와 겹치는 경로는 등록할 수 없습니다.",
      already_registered: "이미 등록된 프로젝트입니다.",
    },
    failed: "프로젝트를 추가하지 못했습니다.",
  },
  archive: {
    rejections: {
      run_in_progress:
        "답변 중인 대화는 보관할 수 없습니다. 끝나거나 멈춘 뒤 다시 시도해 주십시오.",
      session_in_use: "다른 탭에서 쓰고 있는 대화입니다. 그 탭을 닫은 뒤 다시 시도해 주십시오.",
      session_not_found: "대화를 찾을 수 없습니다.",
    },
    failed: "대화를 바꾸지 못했습니다.",
  },
  compact: {
    rejections: {
      run_in_progress: "답변이 끝난 뒤에 비울 수 있습니다.",
      session_in_use: "다른 탭에서 쓰고 있는 대화입니다. 그 탭에서 다시 시도해 주십시오.",
      session_not_found: "대화를 찾을 수 없습니다.",
    },
    failed: "도구 출력을 비우지 못했습니다.",
  },
};
