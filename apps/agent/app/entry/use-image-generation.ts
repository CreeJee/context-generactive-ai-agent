import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useBooleanState } from "react-simplikit";
import { api, ApiError, type GeneratedImageAsset } from "./api";
import { appQueryKeys } from "./events/query-keys";

type Generation =
  | { readonly kind: "idle" }
  | { readonly kind: "generating" }
  | { readonly kind: "generated"; readonly asset: GeneratedImageAsset };

/** The per-request media mode and result; server-owned settings stay in the query cache. */
export function useImageGeneration(onProblem: (message: string) => void) {
  const [intent, , clearIntent, toggleIntent] = useBooleanState(false);
  const [generation, setGeneration] = useState<Generation>({ kind: "idle" });
  const queryClient = useQueryClient();
  const settings =
    useQuery({
      queryKey: appQueryKeys.global.imageSettings,
      queryFn: api.imageSettings,
    }).data ?? null;

  const generate = async (text: string) => {
    setGeneration({ kind: "generating" });
    try {
      setGeneration({ kind: "generated", asset: await api.generateImage(text, true) });
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.code === "image_approval_required" &&
        failure.reason === "cross_provider" &&
        failure.approval
      ) {
        const disclosure =
          "Claude는 이미지를 직접 생성하지 않습니다. 이미지 프롬프트가 OpenAI로 전송되고 사용량은 OpenAI 계정에 귀속됩니다.";
        const once = window.confirm(`${disclosure}\n\n이번 요청에서만 허용할까요?`);
        try {
          if (once) {
            setGeneration({
              kind: "generated",
              asset: await api.generateImage(text, true, failure.approval),
            });
            return;
          }
          const always = window.confirm(
            `${disclosure}\n\n앞으로 Claude 대화에서 OpenAI 이미지 실행을 항상 허용할까요? 취소하면 실행하지 않습니다.`,
          );
          if (!always) return;
          await api.setCrossProviderMediaConsent("always");
          void queryClient.invalidateQueries({ queryKey: appQueryKeys.global.imageSettings });
          setGeneration({ kind: "generated", asset: await api.generateImage(text, true) });
          return;
        } catch {
          onProblem(
            "공급자 간 이미지 실행 승인을 적용하지 못했어요. 설정과 계정 권한을 확인해 주세요.",
          );
          return;
        }
      }
      onProblem("이미지를 생성하지 못했어요. 설정, 계정 권한과 경로 상태를 확인해 주세요.");
    } finally {
      setGeneration((current) => (current.kind === "generating" ? { kind: "idle" } : current));
    }
  };

  return {
    intent,
    clearIntent,
    toggleIntent,
    settings,
    generating: generation.kind === "generating",
    asset: generation.kind === "generated" ? generation.asset : null,
    generate,
  };
}
