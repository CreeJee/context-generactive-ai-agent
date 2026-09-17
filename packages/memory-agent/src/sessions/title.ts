/** Titles use already-redacted stored message text, never a new model request. */
export function firstMessageTitle(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/g, " "));
  return (
    (characters.length > 60 ? characters.slice(0, 60).join("") + "…" : characters.join("")) ||
    "이미지 대화"
  );
}
