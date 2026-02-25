const TelegramBot = require('node-telegram-bot-api');
const { sanitize } = require('./sanitizer');

/**
 * Creates and configures the Telegram bot for permission notifications
 * and remote prompting.
 *
 * @param {Object} config
 * @param {string} config.token - Telegram Bot API token from @BotFather
 * @param {number} config.chatId - Your authorized Telegram chat ID
 * @param {Function} config.onResponse - Called with keystroke for permission responses
 * @param {Function} config.onMessage - Called with text for prompt messages
 * @param {boolean} config.debug - Enable debug logging
 */
function createBot(config) {
  const { token, chatId, onResponse, onMessage, debug = false } = config;

  if (!token || token === 'your_bot_token_here') {
    console.error('[telegram-bot] ERROR: TELEGRAM_BOT_TOKEN is not set. See .env.example');
    process.exit(1);
  }

  if (!chatId) {
    console.error('[telegram-bot] ERROR: TELEGRAM_CHAT_ID is not set. See .env.example');
    process.exit(1);
  }

  const AUTHORIZED_CHAT_ID = parseInt(chatId, 10);

  const bot = new TelegramBot(token, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: { timeout: 30 },
    },
  });

  // Handle polling errors gracefully (silent — no stdout pollution)
  bot.on('polling_error', () => {});

  // --- Special commands ---

  // /start — welcome + chat ID
  bot.onText(/\/start/, (msg) => {
    const id = msg.chat.id;
    if (id !== AUTHORIZED_CHAT_ID) {
      bot.sendMessage(id, 'Unauthorized. Your chat ID: ' + id);
      return;
    }
    bot.sendMessage(id, [
      '✅ Claude Code Bridge connected!\n',
      '*Commands:*',
      '/status — Check if bridge is running',
      '/esc — Send Escape key',
      '/ctrl+c — Send Ctrl+C',
      '/enter — Send Enter key',
      '\n*Usage:*',
      'Just type any message to send it as a prompt to Claude Code.',
      'Permission prompts will appear with buttons to approve/deny.',
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  // /status
  bot.onText(/\/status/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    bot.sendMessage(msg.chat.id, '🟢 Bridge is running. Type a message to send it to Claude.');
  });

  // /esc — send Escape key
  bot.onText(/\/esc/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (onResponse) onResponse('\x1b');
    bot.sendMessage(msg.chat.id, '⏏️ Sent Esc');
  });

  // /ctrl+c — send interrupt
  bot.onText(/\/ctrl\+c/i, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (onResponse) onResponse('\x03');
    bot.sendMessage(msg.chat.id, '🛑 Sent Ctrl+C');
  });

  // /enter — send Enter key
  bot.onText(/\/enter/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (onResponse) onResponse('\r');
    bot.sendMessage(msg.chat.id, '↵ Sent Enter');
  });

  // --- Permission button presses ---

  bot.on('callback_query', (query) => {
    // Security: only accept from authorized user
    if (query.message.chat.id !== AUTHORIZED_CHAT_ID) {
      bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
      return;
    }

    const keystroke = query.data;

    // Acknowledge the tap
    const labelMap = {
      '1': 'Yes (allowed)',
      '2': 'Yes, allow all for session',
      '3': 'Yes, allow all for session',
      'n': 'Denied',
      '\x1b': 'Cancelled (Esc)',
    };
    const label = labelMap[keystroke] || keystroke;
    bot.answerCallbackQuery(query.id, { text: label });

    // Update the message to show what was selected
    const updatedText = query.message.text + `\n\n--- ${label} ---`;
    bot.editMessageText(updatedText, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});

    // Send keystroke back to bridge
    // Number keys need Enter (\r) to confirm selection
    // Esc is sent as-is
    if (onResponse) {
      if (keystroke === '\x1b') {
        onResponse(keystroke);
      } else {
        onResponse(keystroke + '\r');
      }
    }
  });

  // --- Text messages → Claude prompts ---

  bot.on('message', (msg) => {
    // Ignore non-authorized users
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;

    // Ignore commands (handled above)
    if (msg.text && msg.text.startsWith('/')) return;

    // Forward text as a prompt to Claude Code
    if (msg.text && onMessage) {
      onMessage(msg.text);
      bot.sendMessage(msg.chat.id, `📨 Sent to Claude:\n\`${msg.text.substring(0, 100)}\``, {
        parse_mode: 'Markdown',
      }).catch(() => {});
    }
  });

  /**
   * Send a permission prompt to Telegram with inline buttons
   */
  function sendPrompt(prompt) {
    const toolIcon = {
      'Edit': '📝', 'Write': '📄', 'Bash': '⚡', 'Read': '👁',
      'Glob': '🔍', 'Grep': '🔎', 'WebFetch': '🌐', 'WebSearch': '🌐',
      'Task': '📋', 'Skill': '🔧', 'Unknown': '❓',
    };

    const icon = toolIcon[prompt.tool] || '🔔';
    const target = sanitize(prompt.target, 100);
    const desc = sanitize(prompt.description, 300);

    const text = [
      `${icon} *Claude Code Permission*`,
      ``,
      `*Tool:* ${prompt.tool}`,
      `*Target:* \`${target}\``,
      desc ? `*Action:* ${desc}` : '',
    ].filter(Boolean).join('\n');

    const keyboard = {
      inline_keyboard: [
        prompt.options.map(opt => ({
          text: opt.label,
          callback_data: opt.key,
        })),
      ],
    };

    bot.sendMessage(AUTHORIZED_CHAT_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }).catch(() => {});
  }

  /**
   * Send a plain notification (session start/stop, errors, etc.)
   */
  function sendNotification(text) {
    bot.sendMessage(AUTHORIZED_CHAT_ID, text).catch(() => {});
  }

  /**
   * Stop the bot polling
   */
  function stop() {
    bot.stopPolling();
  }

  return { sendPrompt, sendNotification, stop };
}

module.exports = { createBot };
