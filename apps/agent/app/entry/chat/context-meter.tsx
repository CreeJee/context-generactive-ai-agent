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
  const { usedTokens, cachedTokens, cacheRatio, compactionStage, windowTokens, compactAtTokens } =
    context;
  const share = usedTokens === null ? 0 : Math.min(1, usedTokens / windowTokens);
  const crowded = share >= crowdedShare;
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
        <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
          <motion.span
            className={cn(
              "block h-full rounded-full bg-muted-foreground/60",
              crowded && "bg-warning",
            )}
            initial={false}
            animate={{ width: `${share * 100}%` }}
          />
        </span>
        <span>
          컨텍스트{" "}
          {usedTokens === null ? (
            "-"
          ) : (
            <>
              <AnimatedNumber value={Math.round(share * 100)} />%
            </>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <p>
          {usedTokens === null
            ? "이 대화로 아직 모델에 요청하지 않았어요."
            : `마지막 요청에서 모델이 ${tokens.format(usedTokens)} 토큰을 읽었어요(지침과 도구 포함).`}{" "}
          모델은 최대 {tokens.format(windowTokens)} 토큰을 읽어요.
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
          대화가 약 {tokens.format(compactAtTokens)} 토큰을 넘으면 지난 도구 출력부터 비우고, 앞
          대화는 요약으로 보내요. /compact로 바로 줄일 수도 있어요.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
