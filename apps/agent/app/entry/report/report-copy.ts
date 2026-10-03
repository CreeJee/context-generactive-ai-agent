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
