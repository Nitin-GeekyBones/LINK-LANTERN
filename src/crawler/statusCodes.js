// Human-readable labels for HTTP status codes and for the crawler's own
// non-HTTP error codes. Shared with the frontend via /api/meta/codes.
export const ERROR_CODES = {
  TIMEOUT: { label: 'Timeout', help: 'The server did not answer within the time limit.' },
  DNS: { label: 'Host not found', help: 'The domain name could not be resolved. The site may no longer exist, or the hostname is mistyped.' },
  REFUSED: { label: 'Connection refused', help: 'The server actively refused the connection - nothing is listening on that port.' },
  RESET: { label: 'Connection reset', help: 'The server closed the connection unexpectedly.' },
  UNREACHABLE: { label: 'Host unreachable', help: 'No network route to the server.' },
  TLS: { label: 'TLS/SSL error', help: 'A secure connection could not be established (expired, self-signed or mismatched certificate, or no common protocol).' },
  REDIRECT_LOOP: { label: 'Redirect loop', help: 'The URL redirects back to an address already visited in the same chain.' },
  TOO_MANY_REDIRECTS: { label: 'Too many redirects', help: 'More than 10 redirects were followed without reaching a final page.' },
  NO_LOCATION: { label: 'Redirect without target', help: 'The server sent a redirect status but no Location header.' },
  BAD_REDIRECT: { label: 'Invalid redirect target', help: 'The Location header of a redirect could not be parsed as a URL.' },
  UNSUPPORTED: { label: 'Unsupported scheme', help: 'The link (or a redirect) points to a non-HTTP address.' },
  INVALID_URL: { label: 'Malformed URL', help: 'The link is not a valid URL - for example it contains a backslash or illegal characters. Some browsers silently fix these, others do not.' },
  BLOCKED: { label: 'Blocked address', help: 'The URL resolves to a private or local network address, which this server will not contact.' },
  ROBOTS: { label: 'Excluded by robots.txt', help: "The site's robots.txt asks crawlers not to fetch this URL, so it was not checked. Not counted as an error." },
  NETWORK: { label: 'Network error', help: 'The request failed for a network reason not covered above.' },
  STOPPED: { label: 'Not checked (scan stopped)', help: 'The scan was stopped before this link was checked.' },
};

export const HTTP_STATUS = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Content Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 418: "I'm a teapot",
  421: 'Misdirected Request', 422: 'Unprocessable Content', 423: 'Locked', 425: 'Too Early', 426: 'Upgrade Required',
  429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 508: 'Loop Detected', 520: 'Unknown Error (Cloudflare)',
  521: 'Web Server Is Down (Cloudflare)', 522: 'Connection Timed Out (Cloudflare)', 523: 'Origin Unreachable (Cloudflare)',
  524: 'A Timeout Occurred (Cloudflare)', 525: 'SSL Handshake Failed (Cloudflare)', 526: 'Invalid SSL Certificate (Cloudflare)',
  999: 'Request Denied (non-standard)',
};

export function describeError(code, err) {
  const known = ERROR_CODES[code];
  if (known) return known.label;
  return err?.message ? `Network error: ${err.message}` : 'Network error';
}

export function statusLabel(status, statusText) {
  if (!status) return '';
  return `${status} ${HTTP_STATUS[status] || statusText || ''}`.trim();
}
