# Claude Code Telegram Permission Bridge

> Remote permission approval for Claude Code via Telegram bot on your phone.

## Overview

A Node.js wrapper that runs Claude Code inside a pseudo-terminal (PTY), detects permission prompts, sends them to your phone via Telegram, and forwards your response back to Claude Code.

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | v18+ (already installed) |
| Telegram Account | Free, on your phone |
| Internet Connection | PC must be online for Telegram API |
| Claude Code CLI | Already installed and working |

---

## Dependencies

```json
{
  "dependencies": {
    "node-pty": "^1.0.0",
    "node-telegram-bot-api": "^0.66.0",
    "dotenv": "^16.4.0",
    "strip-ansi": "^7.1.0"
  }
}
```

| Package | Purpose | License |
|---------|---------|---------|
| `node-pty` | Spawn Claude Code in a controllable pseudo-terminal | MIT |
| `node-telegram-bot-api` | Communicate with Telegram Bot API | MIT |
| `dotenv` | Load bot token and chat ID from `.env` | BSD-2 |
| `strip-ansi` | Remove terminal color codes from output for clean parsing | MIT |

**Note:** `node-pty` requires native compilation. On Windows, you need:
- Python 3.x (for node-gyp)
- Visual Studio Build Tools (C++ workload)
- Run: `npm install --global windows-build-tools` if missing

---

## Step 1: Create the Telegram Bot

1. Open Telegram on your phone
2. Search for `@BotFather` and start a chat
3. Send `/newbot`
4. Choose a name: `Claude Code Bridge` (display name, anything works)
5. Choose a username: `your_claude_bridge_bot` (must end in `bot`, must be unique)
6. BotFather replies with a **bot token** like: `7123456789:AAH1bGcJxk9-abc123def456ghi789`
7. **Save this token** - you'll need it in Step 3

### Get Your Chat ID

1. Open a chat with your new bot on Telegram
2. Send `/start` to the bot
3. Open this URL in your browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Look for `"chat":{"id":123456789}` in the JSON response
5. **Save this chat ID** - this is your unique Telegram user ID

---

## Step 2: Project Setup

### File Structure

```
claude-telegram-bridge/
  ├── bridge.js            # Main wrapper script
  ├── prompt-parser.js     # Detects and parses permission prompts
  ├── telegram-bot.js      # Telegram bot handler
  ├── sanitizer.js         # Strips sensitive info from messages
  ├── package.json         # Dependencies
  ├── .env                 # Bot token + chat ID (NEVER commit)
  ├── .gitignore           # Excludes .env
  └── IMPLEMENTATION.md    # This file
```

---

## Step 3: Environment Configuration

### `.env` file

```env
TELEGRAM_BOT_TOKEN=7123456789:AAH1bGcJxk9-abc123def456ghi789
TELEGRAM_CHAT_ID=123456789
```

### `.gitignore`

```
node_modules/
.env
```

---

## Step 4: Implementation Details

### 4.1 `bridge.js` — Main Entry Point

**Responsibilities:**
- Spawns `claude` CLI inside a `node-pty` pseudo-terminal
- Pipes all PTY output to both:
  - The real terminal (so you see everything locally)
  - The prompt parser (for detection)
- Receives responses from Telegram bot and writes keystrokes to PTY
- Passes through local keyboard input as normal (so local approval still works)

**Flow:**
```
Terminal Input ──┐
                  ├──▶ PTY (Claude Code) ──▶ Terminal Output
Telegram Reply ──┘                          ──▶ Prompt Parser ──▶ Telegram Bot
```

**Key Logic:**
```javascript
// Pseudocode
const pty = require('node-pty');
const { onPromptDetected } = require('./prompt-parser');
const { sendPrompt, onResponse } = require('./telegram-bot');

// Spawn Claude Code
const claude = pty.spawn('claude', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: process.env
});

// Buffer for output analysis
let outputBuffer = '';

// Forward output to terminal + parser
claude.onData((data) => {
  process.stdout.write(data);  // Show locally
  outputBuffer += data;

  const prompt = onPromptDetected(outputBuffer);
  if (prompt) {
    sendPrompt(prompt);        // Send to Telegram
    outputBuffer = '';          // Reset buffer
  }

  // Trim buffer to prevent memory leak
  if (outputBuffer.length > 10000) {
    outputBuffer = outputBuffer.slice(-5000);
  }
});

// Forward local keyboard input to Claude
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  claude.write(data.toString());
});

// Forward Telegram responses to Claude
onResponse((keystroke) => {
  claude.write(keystroke);
});

// Handle exit
claude.onExit(() => {
  console.log('Claude Code exited.');
  process.exit();
});
```

### 4.2 `prompt-parser.js` — Permission Detection

**Responsibilities:**
- Analyzes terminal output buffer for permission prompt patterns
- Extracts: tool name, file path, action description, available options
- Returns structured prompt object or null

**Detection Strategy:**

Claude Code permission prompts follow recognizable patterns:
- They contain tool names like `Edit`, `Write`, `Bash`, `Read`
- They show numbered options: `1. Allow`, `2. Deny`, etc.
- They contain action descriptions and file paths

```javascript
// Key patterns to detect (after stripping ANSI codes)
const PERMISSION_PATTERNS = [
  /Do you want to (allow|proceed)/i,
  /\[1\].*Allow/i,
  /Allow once/i,
  /Allow always/i,
  // Claude Code specific patterns - will need refinement
  // by testing against actual terminal output
];

function parsePrompt(cleanText) {
  // Extract tool name (Edit, Write, Bash, etc.)
  // Extract file path or command
  // Extract available options with their numbers
  // Return structured object:
  return {
    tool: 'Edit',
    target: 'src/lib/auth.ts',
    description: 'Replace lines 45-52',
    options: [
      { key: '1', label: 'Allow' },
      { key: '2', label: 'Deny' },
      { key: '3', label: 'Always allow' }
    ]
  };
}
```

**IMPORTANT:** The exact prompt format needs to be captured by running Claude Code in the PTY and logging the raw output. The patterns above are approximate and will need tuning based on actual output.

### 4.3 `telegram-bot.js` — Telegram Communication

**Responsibilities:**
- Initializes bot with polling (listens for button taps)
- Sends formatted permission prompts with inline keyboard buttons
- Validates that responses come from authorized chat ID only
- Returns selected option to bridge

```javascript
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const AUTHORIZED_CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID);

let responseCallback = null;

function sendPrompt(prompt) {
  const text = `** Claude Code Permission**\n\n`
    + `Tool: ${prompt.tool}\n`
    + `Target: ${prompt.target}\n`
    + `Action: ${prompt.description}`;

  const keyboard = {
    inline_keyboard: [
      prompt.options.map(opt => ({
        text: opt.label,
        callback_data: opt.key
      }))
    ]
  };

  bot.sendMessage(AUTHORIZED_CHAT_ID, text, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// Listen for button taps
bot.on('callback_query', (query) => {
  // SECURITY: Only accept from authorized user
  if (query.message.chat.id !== AUTHORIZED_CHAT_ID) {
    bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
    return;
  }

  const keystroke = query.data; // '1', '2', or '3'

  // Acknowledge the button tap
  bot.answerCallbackQuery(query.id, { text: `Sent: ${keystroke}` });

  // Update the message to show what was selected
  bot.editMessageText(
    query.message.text + `\n\n-- Selected: ${keystroke}`,
    { chat_id: query.message.chat.id, message_id: query.message.message_id }
  );

  // Send keystroke back to bridge
  if (responseCallback) responseCallback(keystroke + '\r');
});

function onResponse(callback) {
  responseCallback = callback;
}

module.exports = { sendPrompt, onResponse };
```

### 4.4 `sanitizer.js` — Security Filtering

**Responsibilities:**
- Strips ANSI escape codes from terminal output
- Removes anything that looks like secrets/tokens/passwords
- Truncates long file contents
- Only passes tool name + file path + brief description

```javascript
const stripAnsi = require('strip-ansi');

const SECRET_PATTERNS = [
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,  // JWT-like tokens
  /(?:password|secret|token|key)\s*[:=]\s*\S+/gi, // key=value secrets
  /(?:sk-|pk-|api-)[A-Za-z0-9]{20,}/g,            // API keys
];

function sanitize(text) {
  let clean = stripAnsi(text);
  for (const pattern of SECRET_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED]');
  }
  // Truncate to 500 chars max for Telegram message
  if (clean.length > 500) {
    clean = clean.substring(0, 500) + '...';
  }
  return clean;
}

module.exports = { sanitize };
```

---

## Step 5: Package Configuration

### `package.json`

```json
{
  "name": "claude-telegram-bridge",
  "version": "1.0.0",
  "description": "Remote permission approval for Claude Code via Telegram",
  "main": "bridge.js",
  "scripts": {
    "start": "node bridge.js",
    "start:dev": "node bridge.js --verbose"
  },
  "dependencies": {
    "node-pty": "^1.0.0",
    "node-telegram-bot-api": "^0.66.0",
    "dotenv": "^16.4.0",
    "strip-ansi": "^7.1.0"
  }
}
```

---

## Step 6: Usage

### First Time Setup

```bash
cd "C:\Claude apps\claude-telegram-bridge"
npm install
# Edit .env with your bot token and chat ID
```

### Running

```bash
# Instead of running `claude` directly:
cd "C:\Claude apps\grc-app"        # Your project directory
node "C:\Claude apps\claude-telegram-bridge\bridge.js"

# Or with an alias (add to .bashrc):
alias claude-remote='node "C:\Claude apps\claude-telegram-bridge\bridge.js"'
```

### What Happens

1. Claude Code starts normally in your terminal
2. You interact with it as usual (type prompts, see output)
3. When a permission prompt appears:
   - You see it locally as normal
   - Your phone gets a Telegram notification
   - You can approve from **either** the terminal OR Telegram
4. First response wins (local or Telegram)

---

## Step 7: Optional Enhancements (Future)

| Feature | Description |
|---------|-------------|
| Session status | Send a Telegram message when Claude starts/stops |
| Output forwarding | Option to forward Claude's final responses to Telegram |
| Multiple projects | Support different working directories via command args |
| Timeout auto-deny | Auto-deny if no response within X minutes |
| Command passthrough | Send text messages to Telegram that get typed into Claude |
| Log file | Save all permission decisions to a local log |

---

## Security Measures Summary

| Measure | Implementation |
|---------|----------------|
| Chat ID whitelist | Bot ignores all users except your Telegram ID |
| Secret stripping | Regex patterns remove tokens/keys from messages |
| Content truncation | Max 500 chars sent to Telegram |
| `.env` isolation | Token never committed to git |
| Local-only | No cloud server, runs on your PC only |
| No code content | Only sends tool name + file path, not file contents |

---

## Known Limitations

1. **PC must be running** — Bridge only works when your computer is on and connected
2. **Prompt detection** — Regex-based detection may need tuning as Claude Code updates
3. **Latency** — ~1-2 second round trip through Telegram servers
4. **node-pty on Windows** — Requires C++ build tools for native compilation
5. **Single session** — One bridge instance per Claude Code session
6. **No history** — Telegram messages don't persist permission context across sessions

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Bot token leaked | Low | Store in .env, add to .gitignore |
| Someone finds your bot | Low | Chat ID whitelist rejects all others |
| File paths visible to Telegram | Medium | Acceptable for dev work; sanitizer strips secrets |
| node-pty install fails | Medium | Install Windows Build Tools first |
| Prompt pattern changes in Claude update | Medium | Parser patterns may need updating |

---

## Estimated Build Time

| Phase | Time |
|-------|------|
| Telegram bot creation (@BotFather) | 2 minutes |
| Project setup + npm install | 5 minutes |
| Core implementation (bridge + parser + bot) | 30-45 minutes |
| Testing + prompt pattern tuning | 15-20 minutes |
| **Total** | **~1 hour** |

---

## Cost

**$0** — All components are free:
- Telegram Bot API: Free, unlimited
- npm packages: Open source, MIT licensed
- Runs locally: No server/hosting costs
