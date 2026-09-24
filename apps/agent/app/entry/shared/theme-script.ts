/** Runs before paint; a blocked storage API still allows the system theme. */
export const themeScript = `(() => {
  let theme = "system";
  try { theme = localStorage.getItem("context-agent-theme") || "system"; } catch {}
  document.documentElement.classList.toggle("dark",
    theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches));
})();`;
