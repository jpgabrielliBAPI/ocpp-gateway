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
 * Where a URL starts within free text: a scheme not preceded by a scheme
 * character, so each run is scanned once (linear time, whatever the text).
 */
const SCHEME_START = String.raw`(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/`;
/**
 * URLs within free text (an error message quoting a backend, a connection
 * string…), up to the next whitespace: userinfo, query values and fragments
 * may hold any other character, so none may end the URL early.
 */
const URL_IN_TEXT = new RegExp(`${SCHEME_START}\\S*`, "gi");
/** Splits URLs written back to back (`…/path,wss://…`) at each scheme. */
const NEXT_URL = new RegExp(`(?=${SCHEME_START})`, "i");
/** Punctuation closing a URL in prose (brackets, quotes, end of sentence). */
const CLOSING_PUNCTUATION = new Set(")]}>\"'`.,;!");

/** `text` with every URL in it passed through {@link redactUrl}. */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => match.split(NEXT_URL).map(redactUrlInText).join(""));
}

/**
 * One URL cut out of text. Fails closed: a URL whose end cannot be told from
 * the next one (`…/pathwss://…`) is dropped whole, everything up to its last
 * `@` is masked as userinfo, and closing punctuation is only kept as is when
 * it cannot belong to a query value or fragment.
 */
function redactUrlInText(match: string): string {
  const authority = match.indexOf("://") + 3;
  if (match.indexOf("://", authority) !== -1) return "<invalid url>";
  // Masked as text, before parsing: the URL parser reads a password holding
  // "/", "?", "#" or "\" as the end of the host, leaving the rest unmasked.
  const at = match.lastIndexOf("@");
  const url = at >= authority ? `${match.slice(0, authority)}***${match.slice(at)}` : match;
  let end = url.length;
  while (end > 0 && CLOSING_PUNCTUATION.has(url[end - 1])) end--;
  const body = url.slice(0, end);
  if (/[?#]/.test(body)) return redactUrl(url);
  return redactUrl(body) + url.slice(end);
}
