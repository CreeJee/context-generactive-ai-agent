import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  none: {
    label: msg({ message: "안 함", comment: "Compaction stage: the request was sent uncompacted" }),
    detail: msg`대화를 원문 그대로 보냈습니다.`,
    level: 0,
  },
  "clear-answered": {
    label: msg`도구 출력 정리`,
    detail: msg`답변이 끝난 도구 출력을 참조로 바꿔 보냈습니다.`,
    level: 1,
  },
  summarize: {
    label: msg({ message: "요약", comment: "Compaction stage: earlier turns were summarized" }),
    detail: msg`지난 대화 일부를 요약으로 바꿔 보냈습니다.`,
    level: 2,
  },
  "leave-out": {
    label: msg`오래된 메시지 생략`,
    detail: msg`요약으로도 넘쳐 오래된 메시지를 빼고 보냈습니다.`,
    level: 3,
  },
} satisfies Record<
  NonNullable<ContextView["compactionStage"]>,
  { label: MessageDescriptor; level: number; detail: MessageDescriptor }
>;

/** A token count already shortened by `tokens`, such as 13만. */
const tokenCount = (formatted: string) =>
  msg({ message: `${formatted} 토큰`, comment: "{formatted} is a compact number such as 13만" });

/** Cached tokens of the latest request and their share of it. */
const cacheUsage = (formatted: string, percent: number) =>
  msg({
    message: `${formatted} 토큰 · ${percent}%`,
    comment: "{formatted} is a compact token count such as 9.1만; {percent} is a whole percentage",
  });

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
  const { t } = useLingui();
  const { usedTokens, cachedTokens, cacheRatio, compactionStage, windowTokens, windowKnown } =
    context;
  // Historical requests can exceed a catalog limit (including when older middleware sent the
  // un-compacted transcript). In that case a percentage is not a meaningful context gauge.
  const comparable = windowKnown && (usedTokens === null || usedTokens <= windowTokens);
  const share = usedTokens === null || !comparable ? 0 : usedTokens / windowTokens;
  const crowded = comparable && share >= crowdedShare;
  const stage = compactionStage === null ? null : stages[compactionStage];
  const unknown = t({ message: "알 수 없음", comment: "Context card value that is not known" });
  const label = t({
    message: "컨텍스트",
    comment: "Name of the meter of how much of the model's context window the request used",
  });
  const windowLimit = t({ message: "모델 한도", comment: "Context card row: the model's window" });
  const limit = windowKnown ? t(tokenCount(tokens.format(windowTokens))) : unknown;
  const summary =
    usedTokens === null ? (
      "-"
    ) : comparable ? (
      <>
        <AnimatedNumber value={Math.round(share * 100)} />%
      </>
    ) : (
      t(tokenCount(tokens.format(usedTokens)))
    );
  const note = !windowKnown
    ? t`모델 한도를 알 수 없어 사용률은 표시하지 않습니다.`
    : !comparable
      ? t`사용량이 모델 한도보다 커서 사용률은 표시하지 않습니다. 다음 요청부터 새 압축 결과가 반영됩니다.`
      : null;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        render={<Button variant={crowded ? "warning" : "ghost-muted"} size="xs" />}
      >
        {comparable && <ShareBar share={share} crowded={crowded} className="h-1 w-16" />}
        <span>
          {label} {summary}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-72">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <p className="font-medium">{label}</p>
            <p className={cn("text-sm font-medium tabular-nums", crowded && "text-warning")}>
              {summary}
            </p>
          </div>
          {usedTokens === null ? (
            <>
              <p className="text-muted-foreground">
                <Trans>이 대화로 아직 모델에 요청하지 않았습니다.</Trans>
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <Row label={windowLimit}>{limit}</Row>
              </dl>
              {note !== null && <p className="text-muted-foreground">{note}</p>}
            </>
          ) : (
            <>
              {comparable && <ShareBar share={share} crowded={crowded} className="h-1.5 w-full" />}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <Row
                  label={t({
                    message: "마지막 요청",
                    comment: "Context card row: tokens the latest request used",
                  })}
                >
                  {t(tokenCount(tokens.format(usedTokens)))}
                </Row>
                <Row label={windowLimit}>{limit}</Row>
                <Row
                  label={t({
                    message: "캐시",
                    comment: "Context card row: prompt-cache hits of the latest request",
                  })}
                >
                  {cachedTokens === null || cacheRatio === null
                    ? t({
                        message: "보고 안 됨",
                        comment: "Context card value: the provider did not report cache use",
                      })
                    : t(cacheUsage(tokens.format(cachedTokens), Math.round(cacheRatio * 100)))}
                </Row>
                <Row
                  label={t({
                    message: "압축",
                    comment: "Context card row: how strongly the conversation was compacted",
                  })}
                >
                  {stage !== null && <StageLevel level={stage.level} />}
                  {stage === null ? unknown : t(stage.label)}
                </Row>
              </dl>
              {stage !== null && <p className="text-muted-foreground">{t(stage.detail)}</p>}
              {note !== null && <p className="text-muted-foreground">{note}</p>}
              <p className="border-t pt-2 text-muted-foreground">
                <Trans>
                  지침과 도구 정의를 포함한 마지막 요청 기준입니다. /compact로 지금 줄일 수
                  있습니다.
                </Trans>
              </p>
            </>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
