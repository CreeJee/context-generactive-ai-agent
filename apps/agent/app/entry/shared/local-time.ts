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

/** Month, day and minute only, for narrow places such as the sidebar. */
const koreanShortDateTime = {
  locale: "ko-KR",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
} as const;

const formatTimestamp = (
  timestamp: string,
  options: typeof koreanDateTime | typeof koreanShortDateTime,
) =>
  Option.match(DateTime.make(timestamp), {
    onNone: () => "Invalid Date",
    onSome: (at) => DateTime.formatLocal(at, options),
  });

/** A server timestamp as Korean local date and time; an unparsable one reads as `Invalid Date`. */
export const koreanLocalTime = (timestamp: string): string =>
  formatTimestamp(timestamp, koreanDateTime);

/** A server timestamp as Korean local month, day and minute; an unparsable one reads as `Invalid Date`. */
export const koreanShortTime = (timestamp: string): string =>
  formatTimestamp(timestamp, koreanShortDateTime);
