import type { DB } from './db.js';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS } from './config.js';
import { logger } from './log.js';

// Minimal Telegram Bot API client. /start (or adding the bot to a group)
// subscribes a chat, /stop or removing the bot unsubscribes it. Subscribers
// live in the database so restarts keep them. Alerts go only to subscribed
// chats; nothing is ever posted anywhere else.

const log = logger('telegram');
const POLL_TIMEOUT_SECONDS = 30;
const MAX_MESSAGE_LENGTH = 4096;

interface TgChat { id: number; type: string; title?: string; username?: string; first_name?: string }
interface TgMessage { message_id: number; chat: TgChat; text?: string; message_thread_id?: number; is_topic_message?: boolean }
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  my_chat_member?: { chat: TgChat; new_chat_member: { status: string } };
}
interface TgResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number }

export interface Chat { id: string; threadId?: number }
export type CommandHandler = (command: string, args: string[], chat: Chat) => Promise<string | undefined>;

export const SUBSCRIBED_TEXT = 'You will get Asterism alerts here: clusters of strong Solana wallets buying the same token. '
  + 'Commands: /stats /top /wallet &lt;address&gt; /token &lt;CA&gt; /mute &lt;CA&gt; /stop. Not investment advice.';

export function isTelegramConfigured(): boolean {
  return TELEGRAM_BOT_TOKEN.length > 0;
}

async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(40_000),
  });
  const payload = (await response.json()) as TgResponse<T>;
  if (!payload.ok || payload.result === undefined) {
    const error = new Error(`Telegram ${method}: ${payload.description ?? response.statusText}`) as Error & { code?: number };
    error.code = payload.error_code ?? response.status;
    throw error;
  }
  return payload.result;
}

export class Telegram {
  username = '';

  constructor(private readonly db: DB) {}

  chats(): Chat[] {
    const stored = this.db.prepare('SELECT id, thread_id FROM telegram_chats').all() as Array<{ id: string; thread_id: number | null }>;
    const known = new Set(stored.map((row) => row.id));
    const seeded = TELEGRAM_CHAT_IDS.map((entry) => entry.split(':'))
      .filter(([id]) => id && !known.has(id))
      .map(([id, thread]) => ({ id: id!, threadId: thread ? Number(thread) : undefined }));
    return [...stored.map((row) => ({ id: row.id, threadId: row.thread_id ?? undefined })), ...seeded];
  }

  private subscribe(chat: TgChat, threadId?: number): void {
    this.db.prepare(`INSERT INTO telegram_chats (id, type, title, thread_id, added_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id`)
      .run(String(chat.id), chat.type, chat.title ?? chat.username ?? chat.first_name ?? '', threadId ?? null, Math.floor(Date.now() / 1000));
    log.info(`chat subscribed ${chat.id}`);
  }

  private unsubscribe(chatId: string): void {
    this.db.prepare('DELETE FROM telegram_chats WHERE id = ?').run(chatId);
    log.info(`chat unsubscribed ${chatId}`);
  }

  async send(chat: Chat, text: string): Promise<number | undefined> {
    const body = text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
    try {
      const message = await call<{ message_id: number }>('sendMessage', {
        chat_id: chat.id,
        text: body,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(chat.threadId ? { message_thread_id: chat.threadId } : {}),
      });
      return message.message_id;
    } catch (error) {
      const code = (error as { code?: number }).code;
      // Blocked or kicked: drop the chat so we stop trying.
      if (code === 403 || (code === 400 && /chat not found/i.test((error as Error).message))) this.unsubscribe(chat.id);
      throw error;
    }
  }

  async edit(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (error) {
      if (!/message is not modified/i.test((error as Error).message)) throw error;
    }
  }

  /** Sends to every subscriber; returns chat id → message id for later edits. */
  async broadcast(text: string): Promise<Record<string, number>> {
    const sent: Record<string, number> = {};
    for (const chat of this.chats()) {
      try {
        const id = await this.send(chat, text);
        if (id) sent[chat.id] = id;
      } catch (error) {
        log.error(`send to ${chat.id} failed`, error);
      }
    }
    return sent;
  }

  async poll(onCommand: CommandHandler, signal?: AbortSignal): Promise<void> {
    const me = await call<{ username?: string }>('getMe', {});
    this.username = me.username ?? '';
    log.info(`polling as @${this.username}`);
    let offset = 0;
    let backoff = 1_000;
    while (!signal?.aborted) {
      try {
        const updates = await call<TgUpdate[]>('getUpdates', { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message', 'my_chat_member'] },
          AbortSignal.timeout((POLL_TIMEOUT_SECONDS + 10) * 1000));
        backoff = 1_000;
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await this.handle(update, onCommand).catch((error) => log.error('update failed', error));
        }
      } catch (error) {
        if (signal?.aborted) return;
        log.warn('getUpdates failed', error);
        await new Promise((done) => setTimeout(done, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handle(update: TgUpdate, onCommand: CommandHandler): Promise<void> {
    const membership = update.my_chat_member;
    if (membership) {
      const status = membership.new_chat_member.status;
      if (status === 'member' || status === 'administrator') {
        this.subscribe(membership.chat);
        await this.send({ id: String(membership.chat.id) }, `✅ Subscribed. ${SUBSCRIBED_TEXT}`).catch(() => undefined);
      } else if (status === 'left' || status === 'kicked') {
        this.unsubscribe(String(membership.chat.id));
      }
      return;
    }
    const message = update.message;
    if (!message?.text?.startsWith('/')) return;
    const [raw, ...args] = message.text.trim().split(/\s+/);
    const [command, mention] = (raw ?? '').slice(1).split('@');
    if (mention && mention.toLowerCase() !== this.username.toLowerCase()) return;
    const threadId = message.is_topic_message ? message.message_thread_id : undefined;
    const chat: Chat = { id: String(message.chat.id), threadId };
    const name = (command ?? '').toLowerCase();
    if (name === 'start') {
      this.subscribe(message.chat, threadId);
      await this.send(chat, `✅ Subscribed. ${SUBSCRIBED_TEXT}`);
      return;
    }
    if (name === 'stop') {
      this.unsubscribe(chat.id);
      await this.send(chat, '⏹ Unsubscribed. Send /start to get alerts again.');
      return;
    }
    const reply = await onCommand(name, args, chat);
    if (reply) await this.send(chat, reply);
  }
}
