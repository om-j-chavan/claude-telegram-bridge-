const { stripCodes } = require('./sanitizer');

/**
 * Prompt Parser for Claude Code permission requests.
 *
 * Claude Code permission prompts look like:
 *
 *   Do you want to make this edit to src/file.ts?
 *     1. Yes
 *     2. Yes, allow all edits during this session (shift+tab)
 *   > 3. Yes, allow all edits during this session
 *
 *   Do you want to run this command?
 *     1. Yes
 *     2. Yes, allow all commands during this session
 *
 * This parser uses pattern matching + idle detection:
 *   1. Buffer PTY output and strip ANSI codes
 *   2. Score text for permission-prompt likelihood
 *   3. After idle period (Claude is waiting), confirm and send to Telegram
 */

// Strong indicators — Claude Code's actual prompt patterns
const PROMPT_PATTERNS = [
  /do you want to/i,
  /do you want to proceed/i,
  /make this edit/i,
  /run this command/i,
  /create this file/i,
  /allow all edits/i,
  /allow all commands/i,
  /allow all writes/i,
  /during this session/i,
  /don't ask again/i,
];

// Tool name patterns
const TOOL_PATTERNS = [
  /(?:Edit|Write|Bash|Read|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task)\s/i,
];

// Numbered options — very strong indicator
const NUMBERED_OPTION_RE = /^\s*>?\s*[1-3]\.\s*(Yes|No)/m;

// Tool name extraction
const TOOL_NAME_RE = /\b(Edit|Write|Bash|Read|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|Skill)\b/i;

// File path extraction
const FILE_PATH_RE = /(?:[A-Za-z]:)?(?:[\/\\])[\w.\/\\@-]+\.\w+/;

// Bash command extraction — look for command after "Bash" tool indicator
const BASH_CMD_RE = /(?:Bash|command|cmd|run)[:\s(]*[`"]?(.+?)[`")]*$/im;

/**
 * Score how likely the text is a permission prompt (0-1)
 */
function getPermissionScore(cleanText) {
  let score = 0;

  // Check for Claude Code's "Do you want to..." pattern (strongest signal)
  if (/do you want to/i.test(cleanText)) {
    score += 0.4;
  }

  // Check for numbered Yes/No options
  if (NUMBERED_OPTION_RE.test(cleanText)) {
    score += 0.4;
  }

  // Check for tool name mention
  if (TOOL_PATTERNS.some(p => p.test(cleanText))) {
    score += 0.2;
  }

  // Check for session-allow patterns
  if (/during this session/i.test(cleanText)) {
    score += 0.2;
  }

  // Check for specific action phrases
  const actionPatterns = [/make this edit/i, /run this command/i, /create this file/i, /want to proceed/i];
  if (actionPatterns.some(p => p.test(cleanText))) {
    score += 0.2;
  }

  // "don't ask again" is unique to permission prompts
  if (/don't ask again/i.test(cleanText)) {
    score += 0.3;
  }

  return Math.min(score, 1.0);
}

/**
 * Parse a confirmed permission prompt into structured data
 */
function parsePrompt(cleanText) {
  // Extract tool name
  const toolMatch = cleanText.match(TOOL_NAME_RE);
  const tool = toolMatch ? toolMatch[1].charAt(0).toUpperCase() + toolMatch[1].slice(1).toLowerCase() : 'Unknown';

  // Detect tool from context if not found by name
  let detectedTool = tool;
  if (detectedTool === 'Unknown') {
    if (/make this edit/i.test(cleanText)) detectedTool = 'Edit';
    else if (/run this command/i.test(cleanText) || /want to proceed/i.test(cleanText)) detectedTool = 'Bash';
    else if (/create this file/i.test(cleanText)) detectedTool = 'Write';
  }

  // Extract file path
  const fileMatch = cleanText.match(FILE_PATH_RE);

  // Extract bash command
  const cmdMatch = cleanText.match(BASH_CMD_RE);

  // Extract filename from "edit to <filename>?" pattern
  const editToMatch = cleanText.match(/(?:edit to|write to|create)\s+(\S+?)[\s?]/i);

  // Determine target
  let target = 'N/A';
  if (detectedTool.toLowerCase() === 'bash' && cmdMatch) {
    target = cmdMatch[1].substring(0, 100);
  } else if (fileMatch) {
    target = fileMatch[0];
  } else if (editToMatch) {
    target = editToMatch[1];
  }

  // Extract description — find the "Do you want to..." line
  const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
  let description = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (/do you want to/i.test(trimmed)) {
      description = trimmed.substring(0, 200);
      break;
    }
  }

  // Claude Code uses numbered options: 1, 2, 3
  // 1 = Yes (allow once)
  // 2 = Yes, allow all [type] during this session
  // 3 = Yes, allow all [type] during this session (sometimes)
  // Esc = Cancel/Deny
  const options = [
    { key: '1', label: '1. Yes (once)' },
    { key: '2', label: '2. Allow all (session)' },
    { key: '\x1b', label: 'Esc (deny)' },
  ];

  return {
    tool: detectedTool,
    target,
    description: description || `${detectedTool} action requested`,
    options,
    rawText: cleanText.substring(0, 1000),
  };
}

/**
 * Creates a prompt detector with idle-timeout confirmation.
 *
 * Feed PTY output chunks via `feed(data)`. When a permission prompt
 * is detected and output goes idle, `onPrompt` fires.
 *
 * All debug output goes to the debugWrite callback (file only, never stdout).
 *
 * @param {Function} onPrompt - Called with parsed prompt object
 * @param {Object} opts
 * @param {number} opts.idleTimeout - Ms of silence before confirming (default: 800)
 * @param {number} opts.scoreThreshold - Min score to trigger (default: 0.5)
 * @param {Function} opts.debugWrite - Optional function(label, msg) for debug logging
 */
function createDetector(onPrompt, opts = {}) {
  const {
    idleTimeout = 800,
    scoreThreshold = 0.5,
    debugWrite = null,
  } = opts;

  let buffer = '';
  let idleTimer = null;
  let lastPromptTime = 0;
  const COOLDOWN_MS = 1000; // Short cooldown — prompts can come back-to-back

  function log(msg) {
    if (debugWrite) debugWrite('prompt-parser', msg);
  }

  function feed(rawData) {
    buffer += rawData;

    // Keep buffer bounded
    if (buffer.length > 20000) {
      buffer = buffer.slice(-10000);
    }

    // Clear pending idle timer — new data arrived
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Check recent output for permission patterns
    const recentRaw = buffer.slice(-3000);
    const recentClean = stripCodes(recentRaw);
    const score = getPermissionScore(recentClean);

    if (score > 0.2) {
      log(`Score: ${score.toFixed(2)}`);
    }

    if (score >= scoreThreshold) {
      // Potential prompt — wait for idle to confirm
      idleTimer = setTimeout(() => {
        const now = Date.now();
        if (now - lastPromptTime < COOLDOWN_MS) {
          log('Cooldown active, skipping');
          return;
        }

        // Re-check after idle
        const finalClean = stripCodes(buffer.slice(-3000));
        const finalScore = getPermissionScore(finalClean);

        if (finalScore >= scoreThreshold) {
          lastPromptTime = now;
          const prompt = parsePrompt(finalClean);
          log(`CONFIRMED (score=${finalScore.toFixed(2)}): ${prompt.tool} -> ${prompt.target}`);
          onPrompt(prompt);
          buffer = '';
        }
      }, idleTimeout);
    }
  }

  function reset() {
    buffer = '';
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return { feed, reset };
}

module.exports = { createDetector, parsePrompt, getPermissionScore };
