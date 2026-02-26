const { stripCodes } = require('./sanitizer');

/**
 * Prompt Parser for Claude Code permission requests.
 *
 * Detects permission prompts in terminal output and extracts the actual
 * options shown to the user. Uses pattern matching + idle detection.
 */

// Strong indicators — Claude Code's actual prompt patterns
const PROMPT_PATTERNS = [
  /do you want to/i,
  /do you want to proceed/i,
  /make this edit/i,
  /run this command/i,
  /create this file/i,
  /allow all/i,
  /during this session/i,
  /don.?t ask again/i,
];

// Tool name patterns
const TOOL_PATTERNS = [
  /(?:Edit|Write|Bash|Read|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task)\s/i,
];

// Numbered options — very strong indicator
const NUMBERED_OPTION_RE = /^\s*>?\s*[1-4]\.\s*(Yes|No)/m;

// Tool name extraction
const TOOL_NAME_RE = /\b(Edit|Write|Bash|Read|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|Skill)\b/i;

// File path extraction
const FILE_PATH_RE = /(?:[A-Za-z]:)?(?:[\/\\])[\w.\/\\@-]+\.\w+/;

// Bash command extraction
const BASH_CMD_RE = /(?:Bash|command|cmd|run)[:\s(]*[`"]?(.+?)[`")]*$/im;

/**
 * Score how likely the text is a permission prompt (0-1)
 */
function getPermissionScore(cleanText) {
  let score = 0;

  if (/do you want to/i.test(cleanText)) score += 0.4;
  if (NUMBERED_OPTION_RE.test(cleanText)) score += 0.4;
  if (TOOL_PATTERNS.some(p => p.test(cleanText))) score += 0.2;
  if (/during this session/i.test(cleanText)) score += 0.2;
  if (/don.?t ask again/i.test(cleanText)) score += 0.3;

  const actionPatterns = [/make this edit/i, /run this command/i, /create this file/i, /want to proceed/i];
  if (actionPatterns.some(p => p.test(cleanText))) score += 0.2;

  return Math.min(score, 1.0);
}

/**
 * Extract the actual numbered options from Claude Code's prompt.
 *
 * Parses lines like:
 *   ❯ 1. Yes
 *     2. Yes, allow all edits during this session (shift+tab)
 *     3. No
 *
 * Returns array of { position, label, hasShiftTab }
 */
function extractOptions(cleanText) {
  const options = [];
  const lines = cleanText.split('\n');

  for (const line of lines) {
    // Match lines like "❯ 1. Yes", "  2. Yes, allow all...", "> 1 Yes", "3 No"
    // The period after the number is optional (can get stripped with ANSI codes)
    const match = line.match(/^\s*[❯>]?\s*(\d+)\.?\s+(.+)$/);
    if (match) {
      const position = parseInt(match[1], 10);
      let label = match[2].trim();
      // Skip lines that are clearly not options (too long, look like code/paths)
      if (label.length > 100 || /^[\/\\]/.test(label)) continue;

      // Check if this option has a (shift+tab) hint
      const hasShiftTab = /\(shift\+tab\)/i.test(label);

      // Clean up the label — remove keyboard hints like (shift+tab)
      label = label.replace(/\s*\(shift\+tab\)\s*/gi, '').trim();

      options.push({ position, label, hasShiftTab });
    }
  }

  return options;
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
  const cmdMatch = cleanText.match(BASH_CMD_RE);
  const editToMatch = cleanText.match(/(?:edit to|write to|create)\s+(\S+?)[\s?]/i);

  let target = 'N/A';
  if (detectedTool.toLowerCase() === 'bash' && cmdMatch) {
    target = cmdMatch[1].substring(0, 100);
  } else if (fileMatch) {
    target = fileMatch[0];
  } else if (editToMatch) {
    target = editToMatch[1];
  }

  // Extract description
  const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
  let description = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (/do you want to/i.test(trimmed)) {
      description = trimmed.substring(0, 200);
      break;
    }
  }

  // Extract actual options from the prompt text
  const extractedOptions = extractOptions(cleanText);

  // Build Telegram button options from extracted options
  let telegramOptions;

  if (extractedOptions.length >= 2) {
    // Use the actual options from Claude's prompt
    telegramOptions = extractedOptions.map(opt => {
      // Determine the action key based on position and content
      let actionKey;

      if (opt.position === 1) {
        // First option — always "yes" (Enter to confirm default)
        actionKey = `pos_1`;
      } else if (opt.hasShiftTab) {
        // Has shift+tab shortcut
        actionKey = `shift_tab`;
      } else if (/^no$/i.test(opt.label)) {
        // "No" option — use Escape
        actionKey = `deny`;
      } else {
        // Other options — navigate with Down arrows
        actionKey = `pos_${opt.position}`;
      }

      return { key: actionKey, label: opt.label };
    });

    // Always add Deny/Esc if not already present as a "No" option
    const hasNo = telegramOptions.some(o => o.key === 'deny');
    if (!hasNo) {
      telegramOptions.push({ key: 'deny', label: 'Cancel (Esc)' });
    }
  } else {
    // Fallback — couldn't parse options
    telegramOptions = [
      { key: 'pos_1', label: 'Yes' },
      { key: 'deny', label: 'No / Cancel' },
    ];
  }

  return {
    tool: detectedTool,
    target,
    description: description || `${detectedTool} action requested`,
    options: telegramOptions,
    rawText: cleanText.substring(0, 1000),
  };
}

/**
 * Creates a prompt detector with idle-timeout confirmation.
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
  let lastPromptDescription = '';
  const COOLDOWN_MS = 1000;  // Reduced from 2s to 1s for faster auto-approve chains

  function log(msg) {
    if (debugWrite) debugWrite('prompt-parser', msg);
  }

  function isJustAnimation(text) {
    const stripped = text
      .replace(/[✶✻✽✢·●*❯⠂⠐⠈⠠⠄⠁⠃⠇⠋⠙⠸⠴⠦⠖⠒⠑⠘⠰⠤⠆⠊⠃]/g, '')
      .replace(/\b(Implementing|Smooshing|Enchanting|Running|Thinking|Reading|Writing|Searching|Analyzing|Processing)[\w\s…]*\b/gi, '')
      .replace(/\d+\s*(tool uses|tokens|files?|s\b)/g, '')
      .replace(/[─╌│├└┘┐┌┤┬┴┼─]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.length < 20;
  }

  function feed(rawData) {
    buffer += rawData;

    if (buffer.length > 20000) {
      buffer = buffer.slice(-10000);
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    const recentRaw = buffer.slice(-3000);
    const recentClean = stripCodes(recentRaw);
    const score = getPermissionScore(recentClean);

    if (score > 0.2) {
      log(`Score: ${score.toFixed(2)}`);
    }

    if (score >= scoreThreshold) {
      idleTimer = setTimeout(() => {
        const now = Date.now();
        if (now - lastPromptTime < COOLDOWN_MS) {
          log('Cooldown active, skipping');
          return;
        }

        const finalClean = stripCodes(buffer.slice(-3000));
        const finalScore = getPermissionScore(finalClean);

        if (finalScore >= scoreThreshold) {
          if (isJustAnimation(finalClean)) {
            log('Skipping — animation-only output');
            return;
          }

          const prompt = parsePrompt(finalClean);

          const promptKey = `${prompt.tool}:${prompt.target}:${prompt.description}`;
          if (promptKey === lastPromptDescription) {
            log(`Skipping duplicate: ${promptKey}`);
            return;
          }

          lastPromptTime = now;
          lastPromptDescription = promptKey;
          log(`CONFIRMED (score=${finalScore.toFixed(2)}): ${prompt.tool} -> ${prompt.target}`);
          log(`Options: ${JSON.stringify(prompt.options)}`);
          onPrompt(prompt);
          buffer = '';
        }
      }, idleTimeout);
    }
  }

  function reset() {
    buffer = '';
    lastPromptDescription = '';
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearLastPrompt() {
    lastPromptDescription = '';
  }

  return { feed, reset, clearLastPrompt };
}

/**
 * Creates a response tracker that extracts Claude's prose text from PTY output.
 *
 * Claude Code renders prose text with \x1b[1C (cursor-forward-1) between words:
 *   ●[m[1CThis[1Cis[1CClaude's[1Cresponse
 * becomes: "This is Claude's response"
 *
 * This tracker extracts those prose segments in real-time, rather than
 * trying to clean the full raw buffer after the fact.
 */
function createResponseTracker(onSummary, opts = {}) {
  const {
    idleTimeout = 6000,     // Wait 6s of silence — batches prose into one message
    minLength = 15,
    maxLength = 3000,
    sendCooldown = 3000,    // Don't send again within 3s of last send
    debugWrite = null,
  } = opts;

  let proseLines = [];      // Extracted prose text lines
  let idleTimer = null;
  let overlapBuffer = '';    // Tail of previous chunk for cross-chunk matching
  let lastSendTime = 0;
  let lastExtracted = '';    // Last extracted text to avoid overlap duplicates

  function log(msg) {
    if (debugWrite) debugWrite('response-tracker', msg);
  }

  // Noise patterns to reject
  const NOISE_RE = /^(Ruminating|Thinking|Implementing|Smooshing|Enchanting|Spelunking|Pondering|Reasoning|Deliberating|Contemplating|Actualizing|Fermenting|Sock-hopping|Cogitating|Musing|Percolating)/i;
  const TUI_RE = /^(Claude Code|Tip:|esc to interrupt|\? for shortcuts|accept edits|shift\+tab|ctrl\+.*to expand|Conversation compacted)/i;
  const TOOL_RE = /^(Read|Update|Write|Bash|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|Skill|Searched for)\b/i;

  /**
   * Strip ANSI codes except cursor-forward \x1b[\d*C
   */
  function stripNonCursor(rawData) {
    let cleaned = rawData;
    cleaned = cleaned.replace(/\x1b\[\d*(?:;\d+)*m/g, '');
    cleaned = cleaned.replace(/\x1b\[\d+;\d+H/g, '\n');
    cleaned = cleaned.replace(/\x1b\[\d*[ABD]/g, '');
    cleaned = cleaned.replace(/\x1b\[\d*[JKX]/g, '');
    cleaned = cleaned.replace(/\x1b\[\??\d*[a-bd-zG-Z]/g, '');
    cleaned = cleaned.replace(/\x1b\][^\x07]*\x07/g, '');
    cleaned = cleaned.replace(/\x1b\][^\x1b]*(?:\x1b\\)?/g, '');
    return cleaned;
  }

  /**
   * Check if text should be filtered as noise
   */
  function isNoise(text) {
    if (NOISE_RE.test(text)) return true;
    if (TUI_RE.test(text)) return true;
    if (/accept edits on/i.test(text)) return true;
    if (/tab to cycle/i.test(text)) return true;
    if (/esc to interrupt/i.test(text)) return true;
    if (/shift\+tab/i.test(text)) return true;
    if (/ctrl\+[a-z] to/i.test(text)) return true;
    if (/lines?, removed/i.test(text)) return true;
    if (/Added \d+ lines/i.test(text)) return true;
    if (/do you want to/i.test(text)) return true;
    if (/allow all .* during this session/i.test(text)) return true;
    if (/allow reading from/i.test(text)) return true;
    if (/allow .* from this project/i.test(text)) return true;
    if (/Esc to cancel/i.test(text)) return true;
    if (/Tab to amend/i.test(text)) return true;
    if (TOOL_RE.test(text) && text.length < 80) return true;
    return false;
  }

  /**
   * Extract prose text from cleaned data (ANSI stripped except [1C).
   */
  function findProse(cleaned) {
    // Match sequences: word[1C]word[1C]word (2+ spacers = 3+ words)
    // The trailing part captures everything after the last [1C] up to a newline or control char
    const prosePattern = /(?:[\w',.\-:;!?()"\/`]+\x1b\[\d*C){2,}[\w',.\-:;!?()"\/`?]+[^\n\x1b]*/g;
    const matches = cleaned.match(prosePattern) || [];
    const results = [];

    for (const match of matches) {
      let text = match.replace(/\x1b\[\d*C/g, ' ').trim();

      // Clean any remaining ANSI escape remnants
      text = text.replace(/\x1b\[?[0-9;]*[a-zA-Z]/g, '');
      // Remove bare cursor-forward remnants like "1C" glued to words (e.g. "1Cdid")
      // These come from broken \x1b[1C sequences where \x1b[ was stripped
      text = text.replace(/\[?\d{1,2}C(?=[a-zA-Z])/g, ' ');
      text = text.replace(/(?:^|\s)\d{1,2}C(?=\s|$)/g, ' ');
      // Remove [Xm patterns from ANSI leaks
      text = text.replace(/\[\d+m/g, '');
      // Clean up extra whitespace from removals
      text = text.replace(/\s{2,}/g, ' ').trim();

      if (text.length < 15) continue;
      if (isNoise(text)) continue;
      results.push(text);
    }

    return results;
  }

  /**
   * Feed raw PTY output data.
   * Always monitors — no need to "arm".
   */
  function feed(rawData) {
    // Combine with overlap from previous chunk to catch cross-chunk prose
    const combined = overlapBuffer + rawData;

    // Save last 200 chars as overlap for next chunk
    overlapBuffer = rawData.length > 200 ? rawData.slice(-200) : rawData;

    // Strip non-cursor ANSI from combined data
    const cleaned = stripNonCursor(combined);

    // Extract prose
    const extracted = findProse(cleaned);

    if (extracted.length > 0) {
      for (const line of extracted) {
        // Skip if this was already extracted (overlap duplicate)
        if (lastExtracted && lastExtracted.includes(line)) continue;

        // Avoid adding duplicates from overlap matching
        const isDup = proseLines.some(existing =>
          existing.includes(line) || line.includes(existing)
        );
        if (!isDup) {
          proseLines.push(line);
          log(`Extracted: "${line.substring(0, 120)}"`);
        } else {
          // Replace shorter with longer
          const idx = proseLines.findIndex(existing => line.includes(existing) && line.length > existing.length);
          if (idx >= 0) {
            proseLines[idx] = line;
            log(`Extended: "${line.substring(0, 120)}"`);
          }
        }

        lastExtracted = line;
      }

      // Cap accumulated lines
      if (proseLines.length > 50) {
        proseLines = proseLines.slice(-30);
      }
    }

    // Reset idle timer
    if (idleTimer) clearTimeout(idleTimer);

    idleTimer = setTimeout(() => {
      if (proseLines.length === 0) return;

      // Send cooldown — avoid sending two summaries too close together
      const now = Date.now();
      if (now - lastSendTime < sendCooldown) {
        log(`Cooldown active (${Math.round((sendCooldown - (now - lastSendTime)) / 1000)}s left), deferring`);
        // Re-arm the timer to try again later
        idleTimer = setTimeout(() => {
          if (proseLines.length === 0) return;
          sendAccumulated();
        }, sendCooldown - (now - lastSendTime) + 1000);
        return;
      }

      sendAccumulated();
    }, idleTimeout);
  }

  function sendAccumulated() {
    if (proseLines.length === 0) return;

    // Deduplicate — merge overlapping lines
    const deduped = [];
    for (const line of proseLines) {
      if (deduped.length > 0) {
        const prev = deduped[deduped.length - 1];
        if (prev.includes(line) || line.includes(prev)) {
          if (line.length > prev.length) deduped[deduped.length - 1] = line;
          continue;
        }
      }
      deduped.push(line);
    }

    const summary = deduped.join('\n').trim();
    proseLines = [];
    lastSendTime = Date.now();

    if (summary.length < minLength) {
      log(`Summary too short (${summary.length} chars), skipping`);
      return;
    }

    const truncated = summary.length > maxLength
      ? summary.substring(0, maxLength) + '...'
      : summary;

    log(`Sending summary (${truncated.length} chars)`);
    onSummary(truncated);
  }

  function reset() {
    proseLines = [];
    overlapBuffer = '';
    lastExtracted = '';
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function arm() {
    log('Armed (always-on mode)');
  }

  return { arm, feed, reset };
}

module.exports = { createDetector, createResponseTracker, parsePrompt, getPermissionScore, extractOptions };
