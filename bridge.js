#!/usr/bin/env node

/**
 * Claude Code Telegram Permission Bridge
 *
 * Wraps Claude Code in a PTY, detects permission prompts,
 * sends them to your phone via Telegram, and forwards your
 * response back to Claude Code.
 *
 * Usage:
 *   node bridge.js [--debug] [-- ...claude args]
 *
 * Examples:
 *   node bridge.js                          # Start Claude Code normally
 *   node bridge.js --debug                  # With debug logging
 *   node bridge.js -- --model sonnet        # Pass args to Claude
 */

require('dotenv').config({ path: __dirname + '/.env' });

const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { createDetector, createResponseTracker } = require('./prompt-parser');
const { createBot } = require('./telegram-bot');

// --- Parse CLI args ---
const args = process.argv.slice(2);
const DEBUG = args.includes('--debug');
const claudeArgsSeparator = args.indexOf('--');
const claudeArgs = claudeArgsSeparator >= 0 ? args.slice(claudeArgsSeparator + 1) : [];

// --- Debug log file (ALL debug output goes to file, never to stdout) ---
const logPath = path.join(__dirname, 'debug-output.log');
let debugLog = null;
if (DEBUG) {
  debugLog = fs.createWriteStream(logPath, { flags: 'a' });
  debugLog.write(`\n\n=== Session started: ${new Date().toISOString()} ===\n`);
}

function debugWrite(label, data) {
  if (debugLog) {
    debugLog.write(`[${new Date().toISOString()}][${label}] ${data}\n`);
  }
}

// --- Validate env ---
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.error('');
  console.error('  ERROR: Missing environment variables.');
  console.error('  Copy .env.example to .env and fill in your Telegram bot token and chat ID.');
  console.error('  See IMPLEMENTATION.md for setup instructions.');
  console.error('');
  process.exit(1);
}

// --- Determine Claude executable ---
function findClaude() {
  const isWindows = os.platform() === 'win32';

  // On Windows, try claude.cmd first (npm global), then claude
  if (isWindows) {
    // Check common locations
    const candidates = ['claude.cmd', 'claude', 'claude.exe'];
    for (const cmd of candidates) {
      try {
        const { execSync } = require('child_process');
        execSync(`where ${cmd}`, { stdio: 'ignore' });
        return cmd;
      } catch {
        // Not found, try next
      }
    }
  }

  return 'claude';
}

const claudeCmd = findClaude();
debugWrite('bridge', `Using claude command: ${claudeCmd}`);

// --- Initialize Telegram bot ---
let pendingResponse = null;

const bot = createBot({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  debug: DEBUG,
  onResponse: (keystroke) => {
    debugWrite('telegram-response', keystroke);
    if (claudeProcess) {
      claudeProcess.write(keystroke);
    }
    // Clear dedup so next prompt isn't skipped
    detector.clearLastPrompt();
    // Reset prose accumulator so response starts fresh after approval
    responseTracker.reset();
  },
  onMessage: (text) => {
    debugWrite('telegram-message', text);
    // Send the text as a prompt to Claude, followed by Enter to submit.
    // Claude Code detects "paste" when text arrives all at once — Enter
    // during paste just adds a newline. We need a longer delay so Claude
    // treats the Enter as a separate keypress (submit), not part of paste.
    if (claudeProcess) {
      claudeProcess.write(text);
      setTimeout(() => {
        claudeProcess.write('\r');
      }, 500);
    }
  },
});

// --- Initialize response tracker (captures Claude's output after tool execution) ---
const responseTracker = createResponseTracker(
  (summary) => {
    debugWrite('response-summary', summary.substring(0, 200));
    bot.sendSummary(summary);
  },
  {
    idleTimeout: 3000,
    minLength: 15,
    debugWrite: DEBUG ? debugWrite : null,
  }
);

// --- Initialize prompt detector ---
const detector = createDetector(
  (prompt) => {
    debugWrite('prompt-detected', JSON.stringify(prompt));
    // Disarm response tracker — new permission prompt means previous response is done
    responseTracker.reset();
    bot.sendPrompt(prompt);
  },
  {
    idleTimeout: 300,
    scoreThreshold: 0.5,
    debugWrite: DEBUG ? debugWrite : null,
  }
);

// --- Spawn Claude Code in PTY ---
const isWindows = os.platform() === 'win32';
const shell = isWindows ? 'cmd.exe' : '/bin/bash';

// Get terminal size
const cols = process.stdout.columns || 120;
const rows = process.stdout.rows || 40;

console.log('');
console.log('  Claude Code Telegram Bridge');
console.log('  ---------------------------');
console.log('  Permission prompts will be sent to your Telegram.');
console.log('  You can approve from here OR from your phone.');
console.log('  Press Ctrl+C to exit.');
console.log('');

// Spawn claude in PTY
const spawnArgs = isWindows
  ? ['/c', claudeCmd, ...claudeArgs]
  : ['-c', [claudeCmd, ...claudeArgs].join(' ')];

const claudeProcess = pty.spawn(shell, spawnArgs, {
  name: 'xterm-256color',
  cols: cols,
  rows: rows,
  cwd: process.cwd(),
  env: {
    ...process.env,
    // Ensure color output
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    // Allow spawning Claude inside an existing session
    CLAUDECODE: '',
  },
});

// Notify on Telegram that session started
bot.sendNotification('🟢 Claude Code session started.\nPermission prompts will appear here.');

// --- Pipe PTY output to terminal + detector ---
claudeProcess.onData((data) => {
  // Show in local terminal
  process.stdout.write(data);

  // Feed to prompt detector
  detector.feed(data);

  // Feed to response tracker (captures output after tool execution)
  responseTracker.feed(data);

  // Debug log
  debugWrite('pty-output', data.replace(/\n/g, '\\n'));
});

// --- Forward local keyboard input to PTY ---
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key) => {
    // Ctrl+C handling
    if (key === '\u0003') {
      cleanup();
      return;
    }

    // Forward to Claude PTY
    claudeProcess.write(key);
    debugWrite('stdin', key.replace(/\n/g, '\\n'));
  });
}

// --- Handle terminal resize ---
process.stdout.on('resize', () => {
  const newCols = process.stdout.columns || 120;
  const newRows = process.stdout.rows || 40;
  claudeProcess.resize(newCols, newRows);
  debugWrite('resize', `${newCols}x${newRows}`);
});

// --- Handle Claude exit ---
claudeProcess.onExit(({ exitCode, signal }) => {
  debugWrite('exit', `code=${exitCode}, signal=${signal}`);
  bot.sendNotification(`🔴 Claude Code session ended (exit code: ${exitCode || 0}).`);
  cleanup();
});

// --- Graceful shutdown ---
function cleanup() {
  console.log('\n[bridge] Shutting down...');

  detector.reset();
  responseTracker.reset();
  bot.stop();

  if (debugLog) {
    debugLog.write(`=== Session ended: ${new Date().toISOString()} ===\n`);
    debugLog.end();
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  // Give time for Telegram notification to send
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// Handle signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (err) => {
  console.error('[bridge] Uncaught exception:', err.message);
  debugWrite('error', err.stack);
  cleanup();
});
