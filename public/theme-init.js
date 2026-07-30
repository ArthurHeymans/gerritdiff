try {
  const theme = window.localStorage.getItem("gerritdiff-theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // Storage may be unavailable in privacy-restricted browser contexts.
}
