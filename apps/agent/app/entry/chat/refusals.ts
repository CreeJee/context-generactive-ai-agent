import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { Refusal } from "memory-agent/chat-api";

/**
 * Why the server refused a turn or an answer, as the user reads it. Every code the chat API
 * refuses with has its words, so a new code does not compile until it has them.
 */
export const refusalTexts = {
  empty_message: msg`빈 메시지는 보낼 수 없습니다.`,
  unknown_attachment: msg`첨부한 이미지를 서버에서 찾지 못했습니다. 이미지를 다시 올려 주십시오.`,
  invalid_stream_offset: msg`답변을 이어서 읽을 위치가 맞지 않습니다. 페이지를 새로 고쳐 주십시오.`,
  login_required: msg`선택한 공급자에 로그인해야 합니다.`,
  session_not_found: msg`대화를 찾을 수 없습니다.`,
  project_not_found: msg`프로젝트를 찾을 수 없습니다.`,
  run_not_found: msg`이어서 읽을 답변을 찾을 수 없습니다.`,
  btw_not_found: msg`이 BTW는 삭제되었습니다.`,
  report_requires_local_model: msg`제보 대화는 외부 에이전트가 아닌 선택한 모델로만 답합니다. 대화 상대를 모델로 바꿔 주십시오.`,
  run_in_progress: msg`이 대화가 아직 답하는 중입니다.`,
  external_agent_unavailable: msg`선택한 외부 에이전트를 지금 쓸 수 없습니다. 설정에서 연결 상태를 확인해 주십시오.`,
  run_id_conflict: msg`요청 번호가 다른 대화의 요청과 겹쳤습니다. 다시 보내 주십시오.`,
  run_outcome_uncertain: msg`앞선 실행이 끝났는지 확인하지 못해 새 요청을 받지 않았습니다. 그 실행을 확인한 뒤 이어서 진행해 주십시오.`,
  run_already_completed: msg`이미 끝난 요청입니다.`,
  workflow_changed: msg`그사이 Goal이나 Plan이 바뀌었습니다. 바뀐 내용을 확인한 뒤 다시 보내 주십시오.`,
  legacy_unbound: msg`이전 버전에서 만든 Goal이라 자동으로 실행할 수 없습니다. Goal을 다시 정해 주십시오.`,
  owner_mismatch: msg`이 Goal은 이미 다른 실행이 맡고 있습니다.`,
  automatic_goal_admission_unavailable: msg`지금은 Goal 실행을 시작할 수 없습니다. 잠시 뒤 다시 보내 주십시오.`,
  queued_message_not_next: msg`대기열 메시지를 고치는 사이라 보내지 않았습니다. 대기열에서 확인한 뒤 보내 주십시오.`,
  no_user_turn: msg`보낼 메시지가 없습니다.`,
  model_unavailable_for_account: msg`선택한 모델을 지금 계정에서 쓸 수 없습니다. 모델을 다시 골라 주십시오.`,
  image_direct_workflow_required: msg`이 이미지 요청은 대화가 아닌 이미지 생성으로 보내 주십시오.`,
  notification_followup_deferred: msg`앞선 답변이 끝나지 않아 후속 실행을 미뤘습니다.`,
  model_selection_required: msg`먼저 모델을 선택해 주십시오.`,
  images_not_supported: msg`선택한 모델은 이미지를 읽지 못합니다.`,
  provider_image_generation_unavailable: msg`선택한 공급자는 이미지를 만들 수 없습니다.`,
  report_image_generation_unavailable: msg`제보 대화에서는 이미지를 만들 수 없습니다.`,
  image_route_unavailable: msg`이미지를 만들 경로가 없습니다. 설정에서 이미지 생성을 확인해 주십시오.`,
  session_in_use: msg`다른 창이 이 대화를 쓰고 있습니다.`,
  goal_ledger_unavailable: msg`Goal 기록을 읽지 못해 실행하지 않았습니다. 잠시 뒤 다시 보내 주십시오.`,
  goal_workflow_admission_failed: msg`Goal 실행을 시작하지 못했습니다. 잠시 뒤 다시 보내 주십시오.`,
  provider_auth_unavailable: msg`인증 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주십시오.`,
  provider_unavailable: msg`선택한 제공자를 사용할 수 없습니다. 제공자 설정을 확인해 주십시오.`,
  goal_workflow_saturated: msg`실행 중인 작업이 많아 Goal 실행을 시작하지 못했습니다. 잠시 뒤 다시 보내 주십시오.`,
} satisfies Record<Refusal["error"], MessageDescriptor>;
