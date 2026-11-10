/** Copy an ACP editor such as Zed shows for the bridge. Checked by tools/copy-check. */
export const acpCopy = {
  /** App failure codes the editor gets explained, keyed by the app's code. */
  failure: {
    unreachable: "앱에 연결하지 못했습니다. context-generactive-agent 앱을 먼저 실행해 주십시오.",
    login_required: "앱에서 지금 쓰는 모델 제공자에 로그인해 주십시오.",
    model_selection_required: "앱에서 모델을 선택해 주십시오.",
    session_in_use: "다른 창에서 쓰고 있는 대화입니다.",
    session_not_found: "그런 대화가 없습니다.",
  },
  /** Any other app failure code, quoted as is. */
  appRequestFailed: (code: string) => `앱 요청이 실패했습니다: ${code}`,
  /** Why the bridge refused an editor's request itself, keyed by the refusal's tag. */
  refusal: {
    FolderNotFound: (cwd: string) => `폴더를 찾을 수 없습니다: ${cwd}`,
    ProjectNotRegistered: (root: string) =>
      `등록된 프로젝트가 아닙니다. 앱에서 ${root}를 먼저 추가해 주십시오.`,
    SessionNotOpen: "그런 세션이 없습니다. 새로 시작하거나 다시 불러와 주십시오.",
    TurnInProgress: "이미 답하는 중입니다.",
  },
  /** Who asks for an approval when it is not the session's own agent. */
  requester: {
    subagent: (name: string) => `서브에이전트 ${name}`,
    oneOffSubagent: "일회성 서브에이전트",
    externalAgent: (agent: string) => `외부 에이전트 ${agent}`,
  },
  /** The choices of a permission request. */
  permission: {
    allowOnce: "이번 한 번 허용",
    reject: "거부",
  },
  /** Tool call titles, keyed by tool name. */
  toolTitle: {
    find_memory: "기억 검색",
    read_evidence: "원문 읽기",
    trace_evidence: "근거 추적",
    list_files: "파일 목록",
    search_files: "파일 내용 검색",
    read_file: "파일 읽기",
    write_file: "파일 쓰기",
    edit_file: "파일 편집",
    delete_file: "파일 삭제",
    list_outside_files: "프로젝트 밖 파일 목록",
    read_outside_file: "프로젝트 밖 파일 읽기",
    search_outside_file: "프로젝트 밖 파일 검색",
    run_shell: "셸 실행",
    save_shell_skill: "셸 스킬 저장",
    save_code_skill: "코드 스킬 저장",
    run_skill: "코드 스킬 실행",
    run_code: "코드 실행",
    write_outside_file: "프로젝트 밖 파일 쓰기",
    delete_outside_file: "프로젝트 밖 파일 삭제",
    kagi_search: "웹 검색",
    kagi_extract: "웹 페이지 읽기",
    read_skill: "skill 읽기",
    run_subagent: "서브에이전트 실행",
    message_subagent: "서브에이전트에게 메시지 보내기",
    delegate_to_agent: "외부 에이전트에게 맡기기",
  },
};
