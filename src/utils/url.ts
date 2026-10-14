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

/**
 * URLs within free text (an error message quoting a backend, a connection
 * string…), up to the next whitespace: userinfo, query values and fragments
 * may hold any other character, so none may end the URL early.
 */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Punctuation closing a URL in prose (brackets, quotes, end of sentence): kept as is. */
const TRAILING_PUNCTUATION = /[)\]}>"'`.,;!]+$/;

/** `text` with every URL in it passed through {@link redactUrl}. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
    return redactUrl(match.slice(0, match.length - trailing.length)) + trailing;
  });
}
