import { Function as EffectFunction } from "effect";
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const copyReportText: {
  (write: (text: string) => Promise<void>): (text: string) => ReturnType<typeof copyReportTextBody>;
} & typeof copyReportTextBody = EffectFunction.dual(2, copyReportTextBody);
async function copyReportTextBody(
  text: string,
  write: (text: string) => Promise<void>,
): Promise<boolean> {
  try {
    await write(text);
    return true;
  } catch {
    // The read-only preview remains selectable even if Clipboard API is denied/unavailable.
    return false;
  }
}
