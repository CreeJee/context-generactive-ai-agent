import type { ContextView } from "memory-agent/definitions";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { AnimatedNumber } from "~/components/ui/animated-number";
import { Button } from "~/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card";
import { cn } from "~/lib/utils";
import { chatCopy } from "./copy";

const copy = chatCopy.contextMeter;

const tokens = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });

/** Past this share the line turns to a warning: the model is close to what it can read. */
const crowdedShare = 0.6;

/**
 * What each compaction stage did to the latest request, weakest first. `level` fills that many of
 * the three steps beside the name.
 */
const stages = {
  none: { ...copy.stages.none, level: 0 },
  "clear-answered": { ...copy.stages["clear-answered"], level: 1 },
  summarize: { ...copy.stages.summarize, level: 2 },
  "leave-out": { ...copy.stages["leave-out"], level: 3 },
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
  const limit = windowKnown ? copy.tokenCount(tokens.format(windowTokens)) : copy.unknown;
  const summary =
    usedTokens === null ? (
      "-"
    ) : comparable ? (
      <>
        <AnimatedNumber value={Math.round(share * 100)} />%
      </>
    ) : (
      copy.tokenCount(tokens.format(usedTokens))
    );
  const note = !windowKnown ? copy.windowUnknown : !comparable ? copy.overWindow : null;
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        render={<Button variant={crowded ? "warning" : "ghost-muted"} size="xs" />}
      >
        {comparable && <ShareBar share={share} crowded={crowded} className="h-1 w-16" />}
        <span>
          {copy.label} {summary}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-72">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <p className="font-medium">{copy.label}</p>
            <p className={cn("text-sm font-medium tabular-nums", crowded && "text-warning")}>
              {summary}
            </p>
          </div>
          {usedTokens === null ? (
            <>
              <p className="text-muted-foreground">{copy.noRequestYet}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <Row label={copy.windowLimit}>{limit}</Row>
              </dl>
              {note !== null && <p className="text-muted-foreground">{note}</p>}
            </>
          ) : (
            <>
              {comparable && <ShareBar share={share} crowded={crowded} className="h-1.5 w-full" />}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <Row label={copy.lastRequest}>{copy.tokenCount(tokens.format(usedTokens))}</Row>
                <Row label={copy.windowLimit}>{limit}</Row>
                <Row label={copy.cache}>
                  {cachedTokens === null || cacheRatio === null
                    ? copy.cacheNotReported
                    : copy.cacheUsage(tokens.format(cachedTokens), Math.round(cacheRatio * 100))}
                </Row>
                <Row label={copy.compaction}>
                  {stage !== null && <StageLevel level={stage.level} />}
                  {stage?.label ?? copy.unknown}
                </Row>
              </dl>
              {stage !== null && <p className="text-muted-foreground">{stage.detail}</p>}
              {note !== null && <p className="text-muted-foreground">{note}</p>}
              <p className="border-t pt-2 text-muted-foreground">{copy.footnote}</p>
            </>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
