import { DateTime, Option } from "effect";

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

/** A server timestamp as Korean local date and time; an unparsable one reads as `Invalid Date`. */
export const koreanLocalTime = (timestamp: string): string =>
  Option.match(DateTime.make(timestamp), {
    onNone: () => "Invalid Date",
    onSome: (at) => DateTime.formatLocal(at, koreanDateTime),
  });
