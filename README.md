# Claude Code Telegram Bridge

> Control Claude Code from your phone — approve permissions, send prompts, and manage sessions via Telegram.

## What It Does

A Node.js wrapper that runs Claude Code inside a pseudo-terminal (PTY), detects permission prompts, and sends them to your phone via Telegram with inline buttons. You can also type prompts to Claude directly from Telegram.

```
Your PC                        Telegram Cloud                 Your Phone
┌──────────────────┐          ┌──────────────┐              ┌───────────┐
│  Bridge Script    │──msg───▶│  Telegram    │───push──────▶│ Telegram  │
│  (Node.js)        │          │  Bot API     │              │ App       │
│    │               │◀─reply──│              │◀──tap/type──│           │
│    ▼               │          └──────────────┘              └───────────┘
│  Claude Code      │
│  (runs inside PTY)│
└──────────────────┘
```

## Features

- **Permission approvals from phone** — Edit, Write, Bash, and all other tool prompts sent as Telegram notifications with inline buttons
- **Remote prompting** — Type messages in Telegram and they're sent to Claude as prompts
- **Special keys** — `/esc`, `/ctrl+c`, `/enter` commands for terminal control
- **Session notifications** — Get notified when Claude starts and stops
- **Secret redaction** — API keys, tokens, and connection strings are stripped before sending to Telegram
- **Chat ID whitelist** — Only your Telegram account can control the bot
- **Debug mode** — File-based logging for troubleshooting prompt detection
- **Dual input** — Approve from phone OR local terminal, whichever comes first
- **Zero cost** — Telegram Bot API is free, runs locally on your PC

---

## Quick Start

### 1. Create a Telegram Bot (2 minutes)

1. Open Telegram, search for **@BotFather**, start a chat
2. Send `/newbot`
3. Choose a display name (e.g., `Claude Code Bridge`)
4. Choose a username (must end in `bot`, e.g., `my_claude_bridge_bot`)
5. Save the **bot token** BotFather gives you

### 2. Get Your Chat ID

1. Open a chat with your new bot on Telegram
2. Send `/start`
3. Open this URL in your browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Find `"chat":{"id":123456789}` in the JSON response — that's your chat ID

### 3. Install

```bash
git clone https://github.com/om-j-chavan/claude-telegram-bridge.git
cd claude-telegram-bridge
npm install
```

### 4. Configure

```bash
cp .env.example .env
```

Edit `.env` with your bot token and chat ID:

```env
TELEGRAM_BOT_TOKEN=7123456789:AAH1bGcJxk9-abc123def456ghi789
TELEGRAM_CHAT_ID=123456789
```

### 5. Run

```bash
# Navigate to your project directory first
cd /path/to/your/project

# Start Claude Code through the bridge
node /path/to/claude-telegram-bridge/bridge.js
```

You'll see Claude Code start normally. Your Telegram bot will send a "session started" notification.

---

## Usage

### Permission Approvals

When Claude Code needs permission (Edit, Write, Bash, etc.), you'll get a Telegram notification:

```
📝 Claude Code Permission

Tool: Edit
Target: src/lib/auth.ts
Action: Do you want to make this edit to auth.ts?

[ 1. Yes (once) ] [ 2. Allow all (session) ] [ Esc (deny) ]
```

Tap a button to respond. You can also approve from the local terminal — whichever comes first.

### Remote Prompting

Just type any message in the Telegram chat — it gets sent to Claude as a prompt:

```
You: "fix the login bug in auth.ts"
Bot: 📨 Sent to Claude: `fix the login bug in auth.ts`
```

### Telegram Commands

| Command | Action |
|---------|--------|
| `/start` | Show welcome message and available commands |
| `/status` | Check if the bridge is running |
| `/esc` | Send Escape key to Claude |
| `/ctrl+c` | Send interrupt (Ctrl+C) to Claude |
| `/enter` | Send Enter key to Claude |

### Debug Mode

```bash
node bridge.js --debug
```

All debug output goes to `debug-output.log` (never to stdout, so Claude's terminal stays clean). Useful for tuning prompt detection patterns.

### Pass Arguments to Claude

```bash
node bridge.js -- --model sonnet
```

Everything after `--` is passed to the `claude` command.

---

## How It Works

### Prompt Detection

The bridge uses a two-phase detection strategy:

1. **Pattern matching** — Scores terminal output for permission-prompt likelihood using Claude Code's actual patterns:
   - `"Do you want to make this edit to..."`
   - `"Do you want to proceed?"`
   - `"1. Yes"`, `"2. Yes, allow all..."`, `"3. No"`
   - `"Esc to cancel"`

2. **Idle confirmation** — After detecting a potential prompt, waits 800ms of silence. If no more output arrives (meaning Claude is waiting for input), confirms it as a real permission prompt.

### ANSI Handling

Claude Code's terminal output is heavily formatted with ANSI escape codes. The bridge:
- Replaces cursor movement codes (`\x1b[1C`) with spaces (so `"Do[1Cyou"` becomes `"Do you"`)
- Strips color/formatting codes
- Collapses multiple spaces

### Security

- **Chat ID whitelist** — Bot ignores all users except the configured chat ID
- **Secret redaction** — JWT tokens, API keys, database URIs, and `key=value` secrets are replaced with `[REDACTED]` before sending to Telegram
- **Content truncation** — Max 500 chars per message
- **`.env` isolation** — Bot token never committed to git
- **Local only** — No cloud server, everything runs on your PC

---

## File Structure

```
claude-telegram-bridge/
├── bridge.js            # Main entry — spawns Claude in PTY, coordinates everything
├── prompt-parser.js     # Detects permission prompts (pattern matching + idle detection)
├── telegram-bot.js      # Telegram bot: buttons, messages, commands
├── sanitizer.js         # ANSI stripping, secret redaction, truncation
├── package.json         # Dependencies
├── .env.example         # Template for bot token + chat ID
├── .env                 # Your actual config (git-ignored)
└── .gitignore           # Excludes .env, node_modules, debug log
```

---

## Dependencies

| Package | Purpose | License |
|---------|---------|---------|
| [node-pty](https://github.com/microsoft/node-pty) | Spawn Claude Code in a controllable pseudo-terminal | MIT |
| [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) | Telegram Bot API communication | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | Load `.env` configuration | BSD-2 |
| [strip-ansi](https://github.com/chalk/strip-ansi) | Remove ANSI escape codes from terminal output | MIT |

**Note:** `node-pty` requires native compilation. On Windows you need:
- Python 3.x
- Visual Studio Build Tools (C++ workload)

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | v18+ |
| Telegram Account | Free |
| Claude Code CLI | Installed and working |
| Internet Connection | PC must be online for Telegram API |

---

## Known Limitations

1. **PC must be running** — Bridge only works when your computer is on and connected
2. **Prompt detection** — Pattern-based detection may need tuning as Claude Code updates its UI
3. **Latency** — ~1-2 second round trip through Telegram servers
4. **Single session** — One bridge instance per Claude Code session
5. **node-pty on Windows** — Requires C++ build tools for native compilation

---

## Security Considerations

| Concern | Risk | Mitigation |
|---------|------|------------|
| Bot token exposure | Low | Stored in `.env`, git-ignored |
| Unauthorized access | Low | Chat ID whitelist rejects all other users |
| File paths in messages | Medium | Acceptable for dev; secrets are redacted |
| Telegram reads messages | Low | Encrypted in transit; not end-to-end encrypted |
| Phone access | Low | Phone lock screen + Telegram app lock |

---

## Cost

**$0** — Everything is free:
- Telegram Bot API: Free, unlimited messages
- All npm packages: Open source (MIT/BSD)
- Runs locally: No server or hosting costs

---

## License

MIT
