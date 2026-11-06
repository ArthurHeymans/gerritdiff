/** Gerrit's SSH login is a username, not a display name or an email address. */
export function sshUsernameError(value: string): string | undefined {
  const username = value.trim();
  if (!username) return "Enter your Gerrit SSH username to enable Copy.";
  if (username.toUpperCase() === "YOUR_USERNAME") return "Replace the placeholder with your Gerrit SSH username.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) {
    return "Start with a letter or number; use only letters, numbers, dots, underscores or hyphens.";
  }
  return undefined;
}
