import { DateTime, Duration, Function as EffectFunction, Option } from "effect";

/** The fields `toLocaleString` shows: numeric date and time in the browser's time zone. */
const koreanDateTime = {
  locale: "ko-KR",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
} as const;

/** Month, day and minute only, for narrow places such as the sidebar. */
const koreanShortDateTime = {
  locale: "ko-KR",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
} as const;

/** The fields `toLocaleTimeString` shows: hour, minute and second. */
const koreanTimeOfDay = {
  locale: "ko-KR",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
} as const;

const formatTimestamp = (
  timestamp: string | number,
  options: typeof koreanDateTime | typeof koreanShortDateTime | typeof koreanTimeOfDay,
) =>
  Option.match(DateTime.make(timestamp), {
    onNone: () => "Invalid Date",
    onSome: (at) => DateTime.formatLocal(at, options),
  });

/** A server timestamp as Korean local date and time; an unparsable one reads as `Invalid Date`. */
export const koreanLocalTime = (timestamp: string | number): string =>
  formatTimestamp(timestamp, koreanDateTime);

/** A server timestamp as Korean local time of day; an unparsable one reads as `Invalid Date`. */
export const koreanTimeOfDayOf = (timestamp: string | number): string =>
  formatTimestamp(timestamp, koreanTimeOfDay);

/** A server timestamp as Korean local month, day and minute; an unparsable one reads as `Invalid Date`. */
export const koreanShortTime = (timestamp: string): string =>
  formatTimestamp(timestamp, koreanShortDateTime);

/**
 * Time left until a server timestamp in compact units, such as `3d 8h 7m` or `43m`. A passed or
 * unparsable timestamp has nothing left to show.
 */
export const timeUntil: {
  (now: DateTime.DateTime): (timestamp: string) => string | null;
  (timestamp: string, now: DateTime.DateTime): string | null;
} = EffectFunction.dual(2, (timestamp: string, now: DateTime.DateTime): string | null =>
  Option.match(DateTime.make(timestamp), {
    onNone: () => null,
    onSome: (at) => {
      const minutes = Math.floor(Duration.toMillis(DateTime.distance(now, at)) / 60_000);
      if (minutes <= 0) return null;
      const parts = [
        [Math.floor(minutes / 1440), "d"],
        [Math.floor((minutes % 1440) / 60), "h"],
        [minutes % 60, "m"],
      ] as const;
      return parts
        .filter(([value]) => value > 0)
        .map(([value, unit]) => `${value}${unit}`)
        .join(" ");
    },
  }),
);
