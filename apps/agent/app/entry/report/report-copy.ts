// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export async function copyReportText(
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
