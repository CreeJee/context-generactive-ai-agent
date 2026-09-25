import type { ContextView } from "memory-agent/definitions";
import { motion } from "motion/react";
import { AnimatedNumber } from "~/components/ui/animated-number";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

const tokens = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });

/** Past this share the line turns to a warning: the model is close to what it can read. */
const crowdedShare = 0.6;

/**
 * The status line under the input box: how much of the model's context the latest request of this
 * conversation took, with what that means on hover.
 */
export function ContextMeter({ context }: { context: ContextView }) {
  const { usedTokens, cachedTokens, cacheRatio, compactionStage, windowTokens, windowKnown } =
    context;
  const share = usedTokens === null || !windowKnown ? 0 : usedTokens / windowTokens;
  const crowded = windowKnown && share >= crowdedShare;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "flex items-center gap-2 rounded-sm text-2xs text-muted-foreground",
              crowded && "text-warning",
            )}
          />
        }
      >
        {windowKnown && (
          <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <motion.span
              className={cn(
                "block h-full rounded-full bg-muted-foreground/60",
                crowded && "bg-warning",
              )}
              initial={false}
              animate={{ width: `${Math.min(share, 1) * 100}%` }}
            />
          </span>
        )}
        <span>
          컨텍스트{" "}
          {usedTokens === null ? (
            "-"
          ) : windowKnown ? (
            <>
              <AnimatedNumber value={Math.round(share * 100)} />%
            </>
          ) : (
            `${tokens.format(usedTokens)} 토큰`
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <p>
          {usedTokens === null
            ? "이 대화로 아직 모델에 요청하지 않았어요."
            : `마지막 요청에서 모델이 ${tokens.format(usedTokens)} 토큰을 읽었어요(지침과 도구 포함).`}{" "}
          {windowKnown
            ? `선택한 모델의 카탈로그에 표시된 컨텍스트 한도는 ${tokens.format(windowTokens)} 토큰이에요.`
            : "선택한 모델의 컨텍스트 한도를 확인할 수 없어 사용률은 표시하지 않아요."}
        </p>
        {usedTokens !== null && (
          <p>
            {cachedTokens === null || cacheRatio === null
              ? "공급자가 캐시 사용량을 보고하지 않았어요."
              : `프롬프트 캐시에서 ${tokens.format(cachedTokens)} 토큰(${Math.round(cacheRatio * 100)}%)을 읽었어요.`}{" "}
            압축 단계: {compactionStage ?? "알 수 없음"}.
          </p>
        )}
        <p>
          답변이 끝난 도구 출력은 다음 요청부터 참조로 바꾸고, 준비된 과거 요약은 대화 크기와
          관계없이 사용해요. 긴 대화는 오래된 메시지를 더 줄일 수 있고, /compact로 직접 줄일 수도
          있어요.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
