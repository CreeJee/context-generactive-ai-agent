import type { ConfirmCopy, ProblemCopy } from "../shared/copy-templates";
import type { ApprovalChoice } from "./cross-provider-approval";

/** Copy for image generation. Checked by tools/copy-check. */
export const mediaCopy = {
  crossProviderApproval: {
    title: "OpenAI 이미지 실행을 허용할까요?",
    body: "Claude는 이미지를 직접 생성하지 않습니다. 이미지 프롬프트가 OpenAI로 전송되고 사용량은 OpenAI 계정에 귀속됩니다.",
    choices: { cancel: "취소", once: "이번만 허용", always: "항상 허용" },
  } satisfies ConfirmCopy<ApprovalChoice["_tag"]>,
  imageFailed: {
    what: "이미지를 생성하지 못했습니다.",
    next: "설정과 계정 권한을 확인해 주십시오.",
  } satisfies ProblemCopy,
};
