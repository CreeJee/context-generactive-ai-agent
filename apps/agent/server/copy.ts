/** Copy for the `context-agent` command line: usage and console messages. Checked by lint/wording. */
export const cliCopy = {
  usage: `사용법:
  context-agent [폴더] [--port 5173] [--no-open] [--storage <폴더>] [--broadcast]
      폴더(없으면 실행한 위치)를 프로젝트로 엽니다. 앱이 이미 실행 중이면 그 앱에서 엽니다.
      --broadcast: 이 컴퓨터 밖(같은 네트워크, 컨테이너 밖)에서도 접속할 수 있게 모든 네트워크에 엽니다.
      인증이 없으니 믿을 수 있는 네트워크에서만 써 주십시오.
  context-agent acp [--port 5173]
      에디터(Zed 등)용 ACP 에이전트(실행 중인 앱에 연결)
  context-agent memory <명령> [플래그]
      앱 없이 기억을 읽습니다(읽기 전용): find-memory, read-evidence, trace-evidence, projects.
      자세한 사용법은 context-agent memory --help로 봅니다.
      acp와 memory는 첫 인자에서 예약어입니다. 그 이름의 폴더는 ./acp, ./memory로 엽니다.
  context-agent --version
      실행 파일의 버전, 릴리스 채널과 대상 플랫폼을 표시합니다.`,
  projectAdded: (root: string) => `프로젝트로 추가했습니다: ${root}`,
  projectRegistered: (root: string) => `등록된 프로젝트입니다: ${root}`,
  projectRejected: (reason: string, root: string) =>
    `이 폴더는 프로젝트로 열 수 없습니다(${reason}): ${root}`,
  folderNotFound: (path: string) => `폴더를 찾을 수 없습니다: ${path}`,
  openedInRunningApp: (baseUrl: string) => `이미 실행 중인 앱(${baseUrl})에서 열었습니다.`,
  portInUse: (port: number) =>
    `포트 ${port}를 다른 프로그램이 쓰고 있습니다. --port로 다른 포트를 지정해 주십시오.`,
  startFailed: (message: string) => `서버를 시작하지 못했습니다: ${message}`,
  running: (baseUrl: string) =>
    `Context Agent가 ${baseUrl} 에서 실행 중입니다. Ctrl+C를 누르면 끝납니다.`,
  broadcast: (port: number) =>
    `--broadcast: 모든 네트워크의 ${port} 포트에 열었습니다. 인증이 없으니 같은 네트워크의 누구나 이 앱을 쓸 수 있습니다.`,
};
