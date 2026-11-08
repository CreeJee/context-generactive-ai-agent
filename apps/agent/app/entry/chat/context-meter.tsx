import type { ContextView } from "memory-agent/definitions";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { AnimatedNumber } from "~/components/ui/animated-number";
import { Button } from "~/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card";
import { cn } from "~/lib/utils";

const tokens = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });

/** Past this share the line turns to a warning: the model is close to what it can read. */
const crowdedShare = 0.6;

/**
 * What each compaction stage did to the latest request, weakest first. `level` fills that many of
 * the three steps beside the name.
 */
const stages = {
  none: { label: "안 함", level: 0, detail: "대화를 원문 그대로 보냈어요." },
  "clear-answered": {
    label: "도구 출력 정리",
    level: 1,
    detail: "답변이 끝난 도구 출력을 참조로 바꿔 보냈어요.",
  },
  summarize: { label: "요약", level: 2, detail: "지난 대화 일부를 요약으로 바꿔 보냈어요." },
  "leave-out": {
    label: "오래된 메시지 생략",
    level: 3,
    detail: "요약으로도 넘쳐 오래된 메시지를 빼고 보냈어요.",
  },
} satisfies Record<
  NonNullable<ContextView["compactionStage"]>,
  { label: string; level: number; detail: string }
>;

/** One labelled value in the card. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center justify-end gap-1.5 text-right tabular-nums">{children}</dd>
    </>
  );
}

/** The bar of how much of the window the latest request took. */
function ShareBar({
  share,
  crowded,
  className,
}: {
  share: number;
  crowded: boolean;
  className: string;
}) {
  return (
    <span className={cn("block overflow-hidden rounded-full bg-muted", className)}>
      <motion.span
        className={cn("block h-full rounded-full bg-muted-foreground/60", crowded && "bg-warning")}
        initial={false}
        animate={{ width: `${Math.min(share, 1) * 100}%` }}
      />
    </span>
  );
}

/** Three steps filled up to how strongly the latest request was compacted. */
function StageLevel({ level }: { level: number }) {
  return (
    <span aria-hidden className="flex gap-0.5">
      {[1, 2, 3].map((step) => (
        <span
          key={step}
          className={cn(
            "h-1.5 w-2.5 rounded-full bg-muted",
            step <= level && "bg-muted-foreground/60",
          )}
        />
      ))}
    </span>
  );
}

/**
 * The status line under the input box: how much of the model's context the latest request of this
 * conversation took, with the numbers behind it on hover.
 */
export function ContextMeter({ context }: { context: ContextView }) {
  const { usedTokens, cachedTokens, cacheRatio, compactionStage, windowTokens, windowKnown } =
    context;
  // Historical requests can exceed a catalog limit (including when older middleware sent the
  // un-compacted transcript). In that case a percentage is not a meaningful context gauge.
  const comparable = windowKnown && (usedTokens === null || usedTokens <= windowTokens);
  const share = usedTokens === null || !comparable ? 0 : usedTokens / windowTokens;
  const crowded = comparable && share >= crowdedShare;
  const stage = compactionStage === null ? null : stages[compactionStage];
  const limit = windowKnown ? `${tokens.format(windowTokens)} 토큰` : "알 수 없음";
  const summary =
    usedTokens === null ? (
      "-"
    ) : comparable ? (
      <>
        <AnimatedNumber value={Math.round(share * 100)} />%
      </>
    ) : (
      `${tokens.format(usedTokens)} 토큰`
    );
  const note = !windowKnown
    ? "모델 한도를 알 수 없어 사용률은 표시하지 않아요."
    : !comparable
      ? "사용량이 모델 한도보다 커서 사용률은 표시하지 않아요. 다음 요청부터 새 압축 결과가 반영돼요."
      : null;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        render={<Button variant={crowded ? "warning" : "ghost-muted"} size="xs" />}
      >
        {comparable && <ShareBar share={share} crowded={crowded} className="h-1 w-16" />}
        <span>컨텍스트 {summary}</span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-72">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <p className="font-medium">컨텍스트</p>
            <p className={cn("text-sm font-medium tabular-nums", crowded && "text-warning")}>
              {summary}
            </p>
          </div>
          {usedTokens === null ? (
            <>
              <p className="text-muted-foreground">이 대화로 아직 모델에 요청하지 않았어요.</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <Row label="모델 한도">{limit}</Row>
              </dl>
              {note !== null && <p className="text-muted-foreground">{note}</p>}
            </>
          ) : (
            <>
              {comparable && <ShareBar share={share} crowded={crowded} className="h-1.5 w-full" />}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <Row label="마지막 요청">{tokens.format(usedTokens)} 토큰</Row>
                <Row label="모델 한도">{limit}</Row>
                <Row label="캐시">
                  {cachedTokens === null || cacheRatio === null
                    ? "보고 안 됨"
                    : `${tokens.format(cachedTokens)} 토큰 · ${Math.round(cacheRatio * 100)}%`}
                </Row>
                <Row label="압축">
                  {stage !== null && <StageLevel level={stage.level} />}
                  {stage?.label ?? "알 수 없음"}
                </Row>
              </dl>
              {stage !== null && <p className="text-muted-foreground">{stage.detail}</p>}
              {note !== null && <p className="text-muted-foreground">{note}</p>}
              <p className="border-t pt-2 text-muted-foreground">
                지침과 도구 정의를 포함한 마지막 요청 기준이에요. /compact로 지금 줄일 수 있어요.
              </p>
            </>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
