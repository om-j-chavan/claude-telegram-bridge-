const TelegramBot = require('node-telegram-bot-api');
const { sanitize } = require('./sanitizer');

/**
 * Creates and configures the Telegram bot for permission notifications
 * and remote prompting.
 */
function createBot(config) {
  const { token, chatId, onResponse, onMessage, debug = false } = config;

  if (!token || token === 'your_bot_token_here') {
    console.error('[telegram-bot] ERROR: TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }
  if (!chatId) {
    console.error('[telegram-bot] ERROR: TELEGRAM_CHAT_ID is not set.');
    process.exit(1);
  }

  const AUTHORIZED_CHAT_ID = parseInt(chatId, 10);

  const bot = new TelegramBot(token, {
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
  });

  bot.on('polling_error', () => {});

  // --- Auto mode state ---
  let autoMode = false;

  // --- Commands ---

  bot.onText(/\/start/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) {
      bot.sendMessage(msg.chat.id, 'Unauthorized. Your chat ID: ' + msg.chat.id);
      return;
    }
    bot.sendMessage(msg.chat.id, [
      '✅ *Claude Code Bridge*\n',
      '📝 Type any message → sent as prompt to Claude',
      '🔘 Tap buttons → approve/deny permissions\n',
      '*Commands:*',
      '/auto — Toggle auto-approve mode',
      '/esc — Send Escape',
      '/ctrl+c — Send Ctrl+C',
      '/enter — Send Enter',
      '/status — Check bridge status',
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  bot.onText(/\/status/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    const mode = autoMode ? '🤖 Auto-approve ON' : '🔘 Manual mode';
    bot.sendMessage(msg.chat.id, `🟢 Bridge active\n${mode}`);
  });

  bot.onText(/\/auto/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    autoMode = !autoMode;
    const status = autoMode
      ? '🤖 *Auto-approve ON*\nAll permissions will be auto-accepted (Yes).'
      : '🔘 *Auto-approve OFF*\nYou will be prompted for each permission.';
    bot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/esc/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (onResponse) onResponse('\x1b');
    bot.sendMessage(msg.chat.id, '⏏️ Esc sent');
  });

  bot.onText(/\/ctrl\+c/i, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (onResponse) onResponse('\x03');
    bot.sendMessage(msg.chat.id, '🛑 Ctrl+C sent');
  });

  bot.onText(/\/enter/, (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (onResponse) onResponse('\r');
    bot.sendMessage(msg.chat.id, '↵ Enter sent');
  });

  // --- Permission button presses ---

  bot.on('callback_query', (query) => {
    if (query.message.chat.id !== AUTHORIZED_CHAT_ID) {
      bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
      return;
    }

    const action = query.data;

    // Find the label from the button that was pressed
    let label = action;
    const buttons = query.message.reply_markup?.inline_keyboard?.[0] || [];
    const pressedBtn = buttons.find(b => b.callback_data === action);
    if (pressedBtn) label = pressedBtn.text;

    bot.answerCallbackQuery(query.id, { text: `✓ ${label}` });

    // Update message to show selection
    const updatedText = query.message.text + `\n\n✅ *Selected: ${label}*`;
    bot.editMessageText(updatedText, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    }).catch(() => {});

    if (!onResponse) return;

    sendKeystroke(action);
  });

  /**
   * Send the appropriate keystroke(s) to Claude Code's PTY
   */
  function sendKeystroke(action) {
    const ENTER = '\r';
    const ESC = '\x1b';
    const DOWN = '\x1b[B';
    const SHIFT_TAB = '\x1b[Z';

    if (action === 'deny') {
      onResponse(ESC);
    } else if (action === 'shift_tab') {
      onResponse(SHIFT_TAB);
    } else if (action === 'pos_1') {
      onResponse(ENTER);
    } else if (action === 'pos_2') {
      onResponse(DOWN);
      setTimeout(() => onResponse(ENTER), 150);
    } else if (action === 'pos_3') {
      onResponse(DOWN);
      setTimeout(() => {
        onResponse(DOWN);
        setTimeout(() => onResponse(ENTER), 150);
      }, 150);
    } else {
      onResponse(ENTER);
    }
  }

  // --- Text messages → Claude prompts ---

  bot.on('message', (msg) => {
    if (msg.chat.id !== AUTHORIZED_CHAT_ID) return;
    if (msg.text && msg.text.startsWith('/')) return;

    if (msg.text && onMessage) {
      onMessage(msg.text);
      bot.sendMessage(msg.chat.id, `📨 _${msg.text.substring(0, 80)}_`, {
        parse_mode: 'Markdown',
      }).catch(() => {});
    }
  });

  // --- Send functions ---

  function sendPrompt(prompt) {
    const toolIcon = {
      'Edit': '📝', 'Write': '📄', 'Bash': '⚡', 'Read': '👁',
      'Glob': '🔍', 'Grep': '🔎', 'WebFetch': '🌐', 'WebSearch': '🌐',
      'Task': '📋', 'Skill': '🔧', 'Unknown': '❓',
    };

    const icon = toolIcon[prompt.tool] || '🔔';
    const target = sanitize(prompt.target, 100);
    const desc = sanitize(prompt.description, 200);

    // Auto mode — auto-approve and just notify
    if (autoMode) {
      if (onResponse) {
        onResponse('\r'); // Press Enter (Yes)
      }
      bot.sendMessage(AUTHORIZED_CHAT_ID,
        `${icon} *${prompt.tool}*  \`${target}\`\n${desc}\n\n🤖 *Auto-approved*`, {
        parse_mode: 'Markdown',
      }).catch(() => {});
      return;
    }

    // Manual mode — show buttons
    const text = `${icon} *${prompt.tool}*  \`${target}\`\n${desc}`;

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

  function sendNotification(text) {
    bot.sendMessage(AUTHORIZED_CHAT_ID, text).catch(() => {});
  }

  function isAutoMode() {
    return autoMode;
  }

  function stop() {
    bot.stopPolling();
  }

  return { sendPrompt, sendNotification, isAutoMode, stop };
}

module.exports = { createBot };
