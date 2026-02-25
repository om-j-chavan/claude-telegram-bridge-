const stripAnsi = require('strip-ansi');

const SECRET_PATTERNS = [
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, // JWT tokens
  /(?:password|secret|token|key|apikey|api_key)\s*[:=]\s*\S+/gi,    // key=value secrets
  /(?:sk-|pk-|api-|ghp_|gho_|Bearer\s)[A-Za-z0-9_-]{20,}/g,       // API keys
  /postgresql:\/\/[^\s]+/g,                                          // DB connection strings
  /mongodb(\+srv)?:\/\/[^\s]+/g,                                     // MongoDB URIs
  /-----BEGIN\s+\w+\s+KEY-----[\s\S]*?-----END/g,                   // Private keys
];

/**
 * Strip ANSI escape codes from terminal output.
 *
 * Claude Code uses cursor movement sequences like \x1b[1C (move right 1)
 * to space out text. strip-ansi removes these but doesn't insert spaces,
 * so "Do\x1b[1Cyou" becomes "Doyou" instead of "Do you".
 *
 * We replace cursor movements with spaces BEFORE stripping other ANSI codes.
 */
function stripCodes(text) {
  // Replace cursor forward (\x1b[<n>C) with a space
  let result = text.replace(/\x1b\[\d*C/g, ' ');

  // Replace cursor position sequences with newline
  result = result.replace(/\x1b\[\d+;\d+H/g, '\n');

  // Replace other cursor movements with space
  result = result.replace(/\x1b\[\d*[ABD]/g, ' ');

  // Now strip remaining ANSI codes (colors, formatting, etc.)
  result = stripAnsi(result);

  // Collapse multiple spaces into one
  result = result.replace(/ {2,}/g, ' ');

  return result;
}

/**
 * Remove secrets and sensitive patterns from text
 */
function redactSecrets(text) {
  let clean = text;
  for (const pattern of SECRET_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED]');
  }
  return clean;
}

/**
 * Full sanitization: strip ANSI + redact secrets + truncate
 */
function sanitize(text, maxLength = 500) {
  let clean = stripCodes(text);
  clean = redactSecrets(clean);

  if (clean.length > maxLength) {
    clean = clean.substring(0, maxLength) + '...';
  }
  return clean.trim();
}

module.exports = { stripCodes, redactSecrets, sanitize };
