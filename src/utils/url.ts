/**
 * A backend URL safe to log or echo in an error: userinfo, query parameter
 * values and the fragment may carry credentials, so they are masked. Input that
 * does not parse as a URL is not echoed at all.
 */
export function redactUrl(value: string): string {
  const url = URL.parse(value);
  if (!url) return "<invalid url>";
  if (url.username !== "" || url.password !== "") {
    url.username = "***";
    url.password = "";
  }
  for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "***");
  if (url.hash !== "") url.hash = "***";
  return url.toString();
}

/**
 * `text` (typically an error message) with the userinfo of any URL in it
 * masked, for messages that may quote a connection string.
 */
export function maskUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1***@");
}
