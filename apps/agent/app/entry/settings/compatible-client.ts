import { appFetch } from "../shared/backend-restart";

export interface CompatibleConfiguration {
  baseUrl: string;
  model: string;
  contextWindow: number;
  outputBudget: number;
  toolCalling: boolean;
}
export interface CompatibleStatus {
  configuration: CompatibleConfiguration | null;
  configured: boolean;
  hasApiKey: boolean;
}
export type CompatibleUpdate = CompatibleConfiguration & { apiKey?: string | null };

type CompatibleCommand =
  | ({ action: "update" } & CompatibleUpdate)
  | { action: "test" }
  | { action: "list" };

async function request<T>(body?: CompatibleCommand): Promise<T> {
  const response = await appFetch(
    "/api/settings/compatible",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (response.status === 409)
    throw new Error(
      "키와 설정이 부분적으로 저장됐을 수 있어요. 설정을 새로고침하고 키 상태를 확인해 주세요.",
    );
  if (!response.ok) throw new Error(`호환 공급자 요청에 실패했어요 (${response.status}).`);
  return response.json();
}
export const compatibleClient = {
  status: () => request<CompatibleStatus>(),
  update: (configuration: CompatibleUpdate) =>
    request<CompatibleStatus>({ action: "update", ...configuration }),
  test: () => request<{ ok: true }>({ action: "test" }),
  list: () => request<{ models: readonly { id: string }[] }>({ action: "list" }),
};
export const compatibleQueryKey = ["settings", "openai-compatible"] as const;
