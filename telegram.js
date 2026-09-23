/**
 * Multi-tenant Telegram bot layer. Every user registers themselves (open
 * registration via /start, no admin whitelist) and is scoped strictly by
 * their own Telegram user id (telegramId). This module owns:
 *  - low-level send/notify helpers (all take an explicit telegramId/chatId)
 *  - the long-poll loop + built-in commands that are inherently per-user
 *    account concerns: /start (registration), /help, /wallet, /positions,
 *    /status, /config (view/update), /exportkey (explicit confirmation),
 *    /pause, /resume, /dryrun
 *  - forwarding any other command/text to an externally supplied onMessage
 *    callback (wired up by index.js) with the telegramId, for business-logic
 *    commands (deploy/close/screen/etc.) that belong to the BullMQ
 *    orchestration layer, not this transport module.
 *
 * NOTE: only private chats are supported — chat.id === from.id is assumed,
 * matching how personal trading bots operate (no group/multi-admin chats).
 */

import { log } from "./logger.js";
import {
  ensureUser,
  getUser,
  isRegistered,
  setAgentEnabled,
  setDryRun,
  getUserConfig,
  getUserSecrets,
  updateUserSecrets,
  exportWalletPrivateKey,
  listWallets,
  importUserWallet,
  setActiveWallet,
} from "./user-config-service.js";
import { buildUserContext } from "./tools/context.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { executeTool, CONFIG_MAP } from "./tools/executor.js";
import { CONFIG_SECTION_KEYS } from "./config-defaults.js";
import { scheduleUserCycles, unscheduleUserCycles } from "./queue/queues.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let _offset  = 0;
let _polling = false;
// telegramId -> depth (nested/concurrent live messages for that user)
const _liveMessageDepth = new Map();
// telegramId -> { expiresAt } — pending /exportkey confirmation
const EXPORT_CONFIRM_PHRASE = "CONFIRM EXPORT";
const EXPORT_CONFIRM_TTL_MS = 60_000;
const _pendingExportConfirm = new Map();
// telegramId -> { flatKey, section, expiresAt } — pending /config field edit
const CONFIG_EDIT_TTL_MS = 120_000;
const _pendingConfigEdit = new Map();
const _pendingSecretReveal = new Map();
const _pendingWalletImport = new Map();

// Group every CONFIG_MAP flat key by its config section, preserving declaration
// order, so /config can render "section -> fields -> edit" without duplicating
// the flat-key -> section/field mapping that tools/executor.js already owns.
// Built lazily (not at module top-level) — tools/executor.js and telegram.js
// import each other (executor.js needs notifyDeploy/etc), so CONFIG_MAP is only
// guaranteed to be initialized once both modules have finished loading.
let _configSectionsOrdered = null;
let _configFieldsBySection = null;
function getConfigSectionData() {
  if (_configFieldsBySection) return { sections: _configSectionsOrdered, bySection: _configFieldsBySection };
  _configSectionsOrdered = [];
  _configFieldsBySection = new Map();
  for (const [flatKey, mapEntry] of Object.entries(CONFIG_MAP)) {
    if (HIDDEN_CONFIG_FIELDS.has(flatKey)) continue;
    const [section, , persistPathRaw] = mapEntry;
    if (HIDDEN_CONFIG_SECTIONS.has(section)) continue;
    const persistPath = Array.isArray(persistPathRaw) ? persistPathRaw.slice(1) : [mapEntry[1]];
    if (!_configFieldsBySection.has(section)) {
      _configFieldsBySection.set(section, []);
      _configSectionsOrdered.push(section);
    }
    _configFieldsBySection.get(section).push({ flatKey, persistPath });
  }
  return { sections: _configSectionsOrdered, bySection: _configFieldsBySection };
}

// Per-user API keys / RPC URLs (UserSecret table) — separate from CONFIG_MAP
// (UserConfig) because they're stored encrypted via user-config-service.js's
// updateUserSecrets, not via the update_config tool. Only the fields a typical
// user actually needs to touch are shown here — advanced/rarely-used overrides
// (llmBaseUrl, llmApiKey, hiveMindApiKey, publicApiKey, backendApiUrl) are kept
// out of the bot UI on purpose (still settable via the CLI/DB if ever needed).
const SECRETS_SECTION_KEY = "__secrets__";
const SECRET_FIELD_META = [
  { field: "rpcUrl", label: "rpcUrl", sensitive: false, hint: "Solana RPC URL used for wallet/positions/transactions" },
  { field: "pnlRpcUrl", label: "pnlRpcUrl", sensitive: false, hint: "RPC URL used for the fast PnL poller (can be the same as rpcUrl)" },
  { field: "heliusApiKey", label: "heliusApiKey", sensitive: true, hint: "Helius API key — used for wallet balance lookups" },
  { field: "openrouterApiKey", label: "openrouterApiKey", sensitive: true, hint: "Your OpenRouter API key — REQUIRED for the agent to run" },
  { field: "gmgnApiKey", label: "gmgnApiKey", sensitive: true, hint: "GMGN OpenAPI key — optional, improves token fee/holder data" },
  { field: "lpAgentApiKey", label: "lpAgentApiKey", sensitive: true, hint: "LPAgent API key — optional, used for the zap-in relay deploy path" },
];

// CONFIG_MAP sections/fields hidden from the /config button UI (still editable
// via the CLI's --telegram-id flow or direct DB access if ever needed):
//  - "api" section: only field left is lpAgentRelayEnabled, an advanced toggle.
//  - hiveMind.hiveMindUrl: exposes the backend domain, not user-facing.
//  - allowedLaunchpads/blockedLaunchpads/indicatorIntervals: arrays — typing
//    JSON in a chat reply is not user-friendly, so these stay CLI/DB-only.
const HIDDEN_CONFIG_SECTIONS = new Set(["api"]);
const HIDDEN_CONFIG_FIELDS = new Set(["hiveMindUrl", "allowedLaunchpads", "blockedLaunchpads", "indicatorIntervals"]);

function maskSecretValue(value) {
  if (value == null || value === "") return "(not set)";
  const text = String(value);
  return text.length <= 4 ? "••••" : `••••${text.slice(-4)}`;
}

export function isEnabled() {
  return !!TOKEN;
}

// ─── Core send (all per-telegramId — no global chatId) ────────────
async function postTelegram(chatId, method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function deleteIncomingMessage(telegramId, messageId) {
  if (!messageId) return;
  await postTelegram(telegramId, "deleteMessage", { message_id: messageId });
}

export async function sendMessage(telegramId, text) {
  if (!TOKEN || !telegramId) return;
  return postTelegram(telegramId, "sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(telegramId, text, inlineKeyboard) {
  if (!TOKEN || !telegramId) return;
  const body = { text: String(text).slice(0, 4096), reply_markup: { inline_keyboard: inlineKeyboard }, parse_mode: "HTML" };
  const sent = await postTelegram(telegramId, "sendMessage", body);
  if (sent) return sent;
  // Fallback to plain text (strip tags) when parse_mode=HTML is rejected by Telegram.
  const plain = String(text).replace(/<[^>]+>/g, "").slice(0, 4096);
  return postTelegram(telegramId, "sendMessage", { text: plain, reply_markup: { inline_keyboard: inlineKeyboard } });
}

export async function sendHTML(telegramId, html) {
  if (!TOKEN || !telegramId) return;
  const text = String(html || "").slice(0, 4096);
  const sent = await postTelegram(telegramId, "sendMessage", { text, parse_mode: "HTML" });
  if (sent) return sent;

  // Fallback to plain text when parse_mode=HTML is rejected by Telegram.
  const plain = text
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .slice(0, 4096);
  log("telegram_warn", `sendHTML failed for ${telegramId}, fallback to plain text`);
  return postTelegram(telegramId, "sendMessage", { text: plain });
}

export async function editMessage(telegramId, text, messageId) {
  if (!TOKEN || !telegramId || !messageId) return null;
  return postTelegram(telegramId, "editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(telegramId, text, messageId, inlineKeyboard) {
  if (!TOKEN || !telegramId || !messageId) return null;
  return postTelegram(telegramId, "editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage(telegramId) {
  return (_liveMessageDepth.get(String(telegramId)) || 0) > 0;
}

function createTypingIndicator(telegramId) {
  if (!TOKEN || !telegramId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram(telegramId, "sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(telegramId, title, intro = "Starting...") {
  if (!TOKEN || !telegramId) return null;
  const id = String(telegramId);
  const typing = createTypingIndicator(id);

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(id, text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(id, text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth.set(id, (_liveMessageDepth.get(id) || 0) + 1);
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth.set(id, Math.max(0, (_liveMessageDepth.get(id) || 0) - 1));
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth.set(id, Math.max(0, (_liveMessageDepth.get(id) || 0) - 1));
      typing.stop();
    },
  };
}

// ─── Built-in per-user account commands ────────────────────────────
function formatWalletStatus(user, wallet, positions) {
  const lines = [
    `Wallet: <code>${wallet?.wallet || "?"}</code>`,
    `SOL: ${wallet?.sol ?? "?"}${wallet?.error ? ` (${wallet.error})` : ""}`,
    `Open positions: ${positions?.total_positions ?? positions?.positions?.length ?? 0}`,
    `Agent: ${user.agentEnabled ? "ENABLED" : "disabled"} | Dry-run: ${user.dryRun ? "ON (no real txs)" : "OFF (live trading)"}`,
  ];
  return lines.join("\n");
}

function formatHelpText() {
  return [
    "<b>Hyperscale — Commands</b>",
    "/start — register (creates your wallet)",
    "/status — wallet + positions + agent status",
    "/wallet — wallet address + SOL balance",
    "/wallets — list your wallets and active wallet",
    "/addwallet — import another wallet private key",
    "/usewallet <number> — select your active wallet",
    "/positions — list open positions",
    "/config — browse config sections + API keys/secrets with buttons",
    "/config &lt;section&gt; — view one section as text",
    "/config &lt;key&gt; &lt;value&gt; — update one setting via text",
    "/dryrun on|off — toggle safety dry-run mode",
    "/pause — disable your agent (stops recurring cycles)",
    "/resume — re-enable your agent",
    "/exportkey — export your wallet's private key (requires confirmation)",
  ].join("\n");
}

async function handleWallets(telegramId) {
  if (!(await isRegistered(telegramId))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return;
  }
  const wallets = await listWallets(telegramId);
  if (!wallets.length) {
    await sendMessage(telegramId, "No wallets found. Send /start to create your default wallet.");
    return;
  }
  const lines = wallets.map((wallet, index) =>
    `${index + 1}. ${wallet.isActive ? "✅ ACTIVE " : "   "}<code>${wallet.publicKey}</code>`
  );
  await sendHTML(telegramId, `<b>Your Hyperscale wallets</b>\n\n${lines.join("\n")}\n\nUse /usewallet &lt;number&gt; to select the active wallet.`);
}

async function importWalletFromMessage(telegramId, msg, secretKeyBase58) {
  await deleteIncomingMessage(telegramId, msg?.message_id);
  try {
    const result = await importUserWallet(telegramId, secretKeyBase58);
    if (!result.imported) {
      await sendMessage(telegramId, `That wallet is already in your wallet list${result.isActive ? " and is active" : ""}.`);
      return;
    }
    const wallets = await listWallets(telegramId);
    const index = wallets.findIndex((wallet) => wallet.id === result.id) + 1;
    await sendMessage(telegramId,
      `✅ Wallet imported: ${result.publicKey}\n` +
      `${result.isActive ? "It is now active." : `It was added as wallet #${index}. Your current active wallet was kept unchanged.`}\n` +
      `Use /wallets to review wallets or /usewallet ${index} to select it.`
    );
  } catch (error) {
    await sendMessage(telegramId, `Wallet import failed: ${error.message}`).catch(() => {});
  }
}

async function handleAddWallet(telegramId, msg, argsText) {
  if (!(await isRegistered(telegramId))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return;
  }
  const key = argsText.trim();
  if (key) {
    await importWalletFromMessage(telegramId, msg, key);
    return;
  }
  _pendingWalletImport.set(String(telegramId), { expiresAt: Date.now() + CONFIG_EDIT_TTL_MS });
  await sendMessage(telegramId,
    "Send the wallet private key as your next message. It will be deleted immediately after processing.\n" +
    "The imported wallet will not replace your active wallet automatically. This request expires in 2 minutes."
  );
}

async function handleUseWallet(telegramId, argsText) {
  if (!(await isRegistered(telegramId))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return;
  }
  const wallets = await listWallets(telegramId);
  const selector = argsText.trim();
  const index = Number(selector);
  let target = Number.isInteger(index) && index >= 1 ? wallets[index - 1] : null;
  if (!target && selector) target = wallets.find((wallet) => wallet.id === selector || wallet.publicKey === selector);
  if (!target) {
    await sendMessage(telegramId, "Wallet not found. Use /wallets to see the wallet numbers.");
    return;
  }
  const active = await setActiveWallet(telegramId, target.id);
  await sendMessage(telegramId, `✅ Active wallet changed to ${active.publicKey}`);
}

async function requireRegisteredCtx(telegramId) {
  if (!(await isRegistered(telegramId))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return null;
  }
  return buildUserContext(telegramId);
}

async function handleStart(msg, telegramId) {
  const user = await ensureUser(telegramId, {
    username: msg.from?.username || null,
    firstName: msg.from?.first_name || null,
    lastName: msg.from?.last_name || null,
    languageCode: msg.from?.language_code || null,
  });
  const ctx = await buildUserContext(telegramId);
  const wallet = await getWalletBalances(ctx);
  await sendHTML(telegramId,
    `👋 <b>Welcome to Hyperscale</b>\n\n` +
    `Your wallet: <code>${wallet.wallet || "?"}</code>\n\n` +
    `This bot trades autonomously with YOUR own wallet and YOUR own API keys.\n` +
    `Before enabling the agent:\n` +
    `1. Fund your wallet with SOL\n` +
    `2. Set your API keys/RPC via /config → 🔑 API Keys & Secrets (rpcUrl, heliusApiKey, and llmApiKey or openrouterApiKey are required)\n` +
    `3. Run /resume to enable the agent (starts disabled and in dry-run mode by default for safety)\n\n` +
    `Send /help to see all commands.`
  );
  log("telegram", `[${telegramId}] Registered (agentEnabled=${user.agentEnabled}, dryRun=${user.dryRun})`);
}

async function handleStatus(telegramId) {
  const ctx = await requireRegisteredCtx(telegramId);
  if (!ctx) return;
  try {
    const [wallet, positions] = await Promise.all([getWalletBalances(ctx), getMyPositions(ctx)]);
    await sendHTML(telegramId, formatWalletStatus(ctx.user, wallet, positions));
  } catch (e) {
    await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {});
  }
}

async function handleWallet(telegramId) {
  const ctx = await requireRegisteredCtx(telegramId);
  if (!ctx) return;
  try {
    const wallet = await getWalletBalances(ctx);
    await sendHTML(telegramId,
      `Wallet: <code>${wallet.wallet || "?"}</code>\n` +
      `SOL: ${wallet.sol ?? "?"}${wallet.error ? ` (${wallet.error})` : ""}\n` +
      `USD value: $${wallet.total_usd ?? "?"}`
    );
  } catch (e) {
    await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {});
  }
}

async function handlePositions(telegramId) {
  const ctx = await requireRegisteredCtx(telegramId);
  if (!ctx) return;
  try {
    const { total_positions, positions } = await getMyPositions(ctx);
    if (!total_positions) {
      await sendMessage(telegramId, "No open positions.");
      return;
    }
    const lines = positions.map((p, i) =>
      `${i + 1}. ${p.pair || p.pool?.slice(0, 8)} — PnL: ${p.pnl_usd ?? "?"} (${p.pnl_pct ?? "?"}%)`
    );
    await sendMessage(telegramId, `📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}`);
  } catch (e) {
    await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {});
  }
}

function getNestedValue(obj, path) {
  let target = obj;
  for (const key of path) {
    if (target == null) return undefined;
    target = target[key];
  }
  return target;
}

function formatValueForButton(value, maxLen = 30) {
  const text = Array.isArray(value) ? (value.length ? value.join(",") : "[]")
    : value === null || value === undefined ? "null"
    : typeof value === "object" ? JSON.stringify(value)
    : String(value);
  return text.length > maxLen ? `${text.slice(0, Math.max(1, maxLen - 3))}...` : text;
}

function formatRpcUrlForDisplay(value) {
  if (value == null || value === "") return "(not set)";
  try {
    const url = new URL(String(value));
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "[configured Helius key]");
    return url.toString();
  } catch {
    return String(value);
  }
}

function parseConfigInputValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    try { return JSON.parse(value); } catch { /* fall through, keep as string */ }
  }
  return value;
}

function buildSectionPickerKeyboard() {
  const { sections } = getConfigSectionData();
  const rows = [];
  for (let i = 0; i < sections.length; i += 2) {
    const row = sections.slice(i, i + 2).map((section) => ({
      text: section,
      callback_data: `cfg:sec:${section}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: "🔑 API Keys & Secrets", callback_data: `cfg:sec:${SECRETS_SECTION_KEY}` }]);
  return rows;
}

function buildSectionFieldsKeyboard(ctx, section) {
  const { bySection } = getConfigSectionData();
  const fields = bySection.get(section) || [];
  const rows = fields.map(({ flatKey, persistPath }) => {
    const currentValue = getNestedValue(ctx.config[section], persistPath);
    // Telegram inline button text is capped at 64 bytes — reserve room for the
    // key name (needed to identify the field) and truncate the value harder.
    const valueBudget = Math.max(6, 60 - flatKey.length - 2);
    const displayValue = ["rpcUrl", "pnlRpcUrl"].includes(flatKey)
      ? formatRpcUrlForDisplay(currentValue)
      : currentValue;
    const shortValue = formatValueForButton(displayValue, valueBudget);
    const label = `${flatKey}: ${shortValue}`.slice(0, 64);
    return [{ text: label, callback_data: `cfg:edit:${flatKey}` }];
  });
  rows.push([{ text: "◀ Back to sections", callback_data: "cfg:root" }]);
  return rows;
}

function buildSecretsKeyboard(secrets) {
  const rows = SECRET_FIELD_META.map(({ field, label, sensitive }) => {
    const raw = secrets?.[field];
    const shown = sensitive ? maskSecretValue(raw) : formatValueForButton(raw ?? "(not set)", 40);
    const buttonLabel = `${label}: ${shown}`.slice(0, 64);
    return sensitive
      ? [{ text: buttonLabel, callback_data: `cfg:secedit:${field}` }, { text: "👁 Show", callback_data: `cfg:reveal:${field}` }]
      : [{ text: buttonLabel, callback_data: `cfg:secedit:${field}` }];
  });
  rows.push([{ text: "◀ Back to sections", callback_data: "cfg:root" }]);
  return rows;
}

async function sendSectionPicker(telegramId) {
  await sendMessageWithButtons(telegramId, "⚙️ <b>Config</b> — pick a section to view/edit its fields:", buildSectionPickerKeyboard()).catch(() => {});
}

async function sendSectionFields(telegramId, ctx, section) {
  if (section === SECRETS_SECTION_KEY) {
    const secrets = await getUserSecrets(telegramId);
    const values = SECRET_FIELD_META.map(({ field, label, sensitive }) => {
      const value = sensitive ? maskSecretValue(secrets?.[field]) : formatRpcUrlForDisplay(secrets?.[field]);
      return `${label}: ${value}`;
    }).join("\n");
    await sendMessageWithButtons(telegramId, `🔑 <b>API Keys & Secrets</b>\n\n${values}\n\nTap a field below to change its value:`, buildSecretsKeyboard(secrets)).catch(() => {});
    return;
  }
  const { bySection } = getConfigSectionData();
  if (!bySection.has(section)) {
    await sendMessage(telegramId, `Unknown section "${section}".`).catch(() => {});
    return;
  }
  const values = bySection.get(section).map(({ flatKey, persistPath }) =>
    `${flatKey}: ${JSON.stringify(getNestedValue(ctx.config[section], persistPath))}`
  ).join("\n");
  await sendMessageWithButtons(telegramId, `⚙️ <b>${section}</b>\n\n${values}\n\nTap a field below to change its value:`, buildSectionFieldsKeyboard(ctx, section)).catch(() => {});
}

async function handleConfigCallback(msg, telegramId) {
  const data = msg.callbackData || "";
  const parts = data.split(":"); // cfg:root | cfg:sec:<section> | cfg:edit:<flatKey> | cfg:secedit:<field> | cfg:confirm | cfg:cancel
  const action = parts[1];

  const ctx = await requireRegisteredCtx(telegramId);
  if (!ctx) {
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    return;
  }

  if (action === "root") {
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await sendSectionPicker(telegramId);
    return;
  }

  if (action === "sec") {
    const section = parts.slice(2).join(":");
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await sendSectionFields(telegramId, ctx, section);
    return;
  }

  if (action === "edit") {
    const flatKey = parts.slice(2).join(":");
    const mapEntry = CONFIG_MAP[flatKey];
    if (!mapEntry) {
      await answerCallbackQuery(msg.callbackQueryId, "Unknown field").catch(() => {});
      return;
    }
    const [section, , persistPathRaw] = mapEntry;
    const persistPath = Array.isArray(persistPathRaw) ? persistPathRaw.slice(1) : [mapEntry[1]];
    const currentValue = getNestedValue(ctx.config[section], persistPath);
    _pendingConfigEdit.set(String(telegramId), {
      kind: "config", key: flatKey, section, stage: "awaiting_value", expiresAt: Date.now() + CONFIG_EDIT_TTL_MS,
    });
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await sendHTML(telegramId,
      `<b>${flatKey}</b>\nCurrent value: ${["rpcUrl", "pnlRpcUrl"].includes(flatKey) ? formatRpcUrlForDisplay(currentValue) : JSON.stringify(currentValue)}\n\n` +
      `Send the new value as a plain message (true/false, a number, plain text, or JSON for arrays/objects). ` +
      `You'll get an Update button to confirm before anything is saved.\n\n` +
      `This request expires in 2 minutes. Send /cancel to abort.`
    ).catch(() => {});
    return;
  }

  if (action === "secedit") {
    const field = parts.slice(2).join(":");
    const meta = SECRET_FIELD_META.find((m) => m.field === field);
    if (!meta) {
      await answerCallbackQuery(msg.callbackQueryId, "Unknown field").catch(() => {});
      return;
    }
    const secrets = await getUserSecrets(telegramId);
    _pendingConfigEdit.set(String(telegramId), {
      kind: "secret", key: field, section: SECRETS_SECTION_KEY, stage: "awaiting_value", expiresAt: Date.now() + CONFIG_EDIT_TTL_MS,
    });
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await sendHTML(telegramId,
      `<b>${meta.label}</b>\n${meta.hint}\nCurrent value: ${meta.sensitive ? maskSecretValue(secrets?.[field]) : (secrets?.[field] ?? "(not set)")}\n\n` +
      `Send the new value as a plain message (send "null" to clear it). ` +
      `You'll get an Update button to confirm before anything is saved.\n\n` +
      `This request expires in 2 minutes. Send /cancel to abort.`
    ).catch(() => {});
    return;
  }

  if (action === "reveal") {
    const field = parts.slice(2).join(":");
    const meta = SECRET_FIELD_META.find((m) => m.field === field);
    if (!meta?.sensitive) {
      await answerCallbackQuery(msg.callbackQueryId, "Unknown secret").catch(() => {});
      return;
    }
    _pendingSecretReveal.set(String(telegramId), { field, expiresAt: Date.now() + CONFIG_EDIT_TTL_MS });
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await sendMessageWithButtons(telegramId,
      `⚠️ Showing ${meta.label} will put the complete credential in this chat. Do not forward or share it.`,
      [[{ text: "👁 Show current value", callback_data: `cfg:revealconfirm:${field}` }, { text: "Cancel", callback_data: "cfg:revealcancel" }]]
    ).catch(() => {});
    return;
  }

  if (action === "revealconfirm") {
    const field = parts.slice(2).join(":");
    const pending = _pendingSecretReveal.get(String(telegramId));
    if (!pending || pending.field !== field || Date.now() > pending.expiresAt) {
      _pendingSecretReveal.delete(String(telegramId));
      await answerCallbackQuery(msg.callbackQueryId, "Show request expired").catch(() => {});
      return;
    }
    _pendingSecretReveal.delete(String(telegramId));
    const secrets = await getUserSecrets(telegramId);
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await sendMessage(telegramId, `${field}: ${secrets?.[field] ?? "(not set)"}`).catch(() => {});
    return;
  }

  if (action === "revealcancel") {
    _pendingSecretReveal.delete(String(telegramId));
    await answerCallbackQuery(msg.callbackQueryId, "Cancelled").catch(() => {});
    await sendMessage(telegramId, "Show cancelled.").catch(() => {});
    return;
  }

  if (action === "confirm") {
    await answerCallbackQuery(msg.callbackQueryId).catch(() => {});
    await applyPendingConfigEdit(telegramId);
    return;
  }

  if (action === "cancel") {
    _pendingConfigEdit.delete(String(telegramId));
    await answerCallbackQuery(msg.callbackQueryId, "Cancelled").catch(() => {});
    await sendMessage(telegramId, "Cancelled — nothing was changed.").catch(() => {});
    return;
  }

  await answerCallbackQuery(msg.callbackQueryId, "Unknown action").catch(() => {});
}

/**
 * Handles the plain-text reply after tapping a field: stores the typed value
 * as a PENDING edit and shows an explicit Update/Cancel button pair — nothing
 * is written to the database until the user taps "✅ Update".
 * Returns true if the message was consumed as a pending /config field-edit reply.
 */
async function handleConfigEditSubmission(telegramId, text) {
  const id = String(telegramId);
  const pending = _pendingConfigEdit.get(id);
  if (!pending) return false;

  if (Date.now() > pending.expiresAt) {
    _pendingConfigEdit.delete(id);
    await sendMessage(telegramId, "Config edit expired. Tap the field again to retry.").catch(() => {});
    return true;
  }

  if (pending.stage !== "awaiting_value") return false; // already awaiting button confirm — ignore stray text

  const parsedValue = pending.kind === "secret" ? (text.trim().toLowerCase() === "null" ? null : text.trim()) : parseConfigInputValue(text);
  _pendingConfigEdit.set(id, { ...pending, stage: "awaiting_confirm", parsedValue, expiresAt: Date.now() + CONFIG_EDIT_TTL_MS });

  const label = pending.kind === "secret" ? (SECRET_FIELD_META.find((m) => m.field === pending.key)?.label || pending.key) : pending.key;
  const preview = pending.kind === "secret" && SECRET_FIELD_META.find((m) => m.field === pending.key)?.sensitive
    ? maskSecretValue(parsedValue)
    : JSON.stringify(parsedValue);
  await sendMessageWithButtons(telegramId,
    `${label} → ${preview}\n\nTap Update to save this change.`,
    [[{ text: "✅ Update", callback_data: "cfg:confirm" }, { text: "❌ Cancel", callback_data: "cfg:cancel" }]]
  ).catch(() => {});
  return true;
}

/** Actually persists the pending edit once the user taps "✅ Update". */
async function applyPendingConfigEdit(telegramId) {
  const id = String(telegramId);
  const pending = _pendingConfigEdit.get(id);
  if (!pending || pending.stage !== "awaiting_confirm") {
    await sendMessage(telegramId, "Nothing pending to update.").catch(() => {});
    return;
  }
  _pendingConfigEdit.delete(id);

  const ctx = await requireRegisteredCtx(telegramId);
  if (!ctx) return;

  try {
    if (pending.kind === "secret") {
      await updateUserSecrets(id, { [pending.key]: pending.parsedValue });
      const label = SECRET_FIELD_META.find((m) => m.field === pending.key)?.label || pending.key;
      await sendMessage(telegramId, `✅ Updated ${label}`).catch(() => {});
      await sendSectionFields(telegramId, ctx, SECRETS_SECTION_KEY);
      return;
    }
    const result = await executeTool(ctx, "update_config", { changes: { [pending.key]: pending.parsedValue }, reason: "via /config button" });
    if (!result?.success) {
      await sendMessage(telegramId, `Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || result?.error || "none"}`).catch(() => {});
      return;
    }
    await sendMessage(telegramId, `✅ Updated ${pending.key} = ${JSON.stringify(pending.parsedValue)}`).catch(() => {});
    const refreshedCtx = await buildUserContext(id);
    await sendSectionFields(telegramId, refreshedCtx, pending.section);
  } catch (e) {
    await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {});
  }
}

async function handleConfig(telegramId, argsText) {
  const ctx = await requireRegisteredCtx(telegramId);
  if (!ctx) return;
  const parts = argsText.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    await sendSectionPicker(telegramId);
    return;
  }

  if (parts.length === 1 && CONFIG_SECTION_KEYS.includes(parts[0]) && !HIDDEN_CONFIG_SECTIONS.has(parts[0])) {
    const section = parts[0];
    await sendHTML(telegramId, `<b>${section}</b>\n<pre>${JSON.stringify(ctx.config[section], null, 2).slice(0, 3800)}</pre>`);
    return;
  }

  if (parts.length < 2) {
    await sendMessage(telegramId, `Unknown section "${parts[0]}". Use /config with no args to list sections.`);
    return;
  }

  const key = parts[0];
  const rawValue = parts.slice(1).join(" ");
  const value = parseConfigInputValue(rawValue);

  try {
    const result = await executeTool(ctx, "update_config", { changes: { [key]: value }, reason: "via /config command" });
    if (!result?.success) {
      await sendMessage(telegramId, `Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || result?.error || "none"}`).catch(() => {});
      return;
    }
    await sendMessage(telegramId, `✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
  } catch (e) {
    await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {});
  }
}

async function handleExportKey(telegramId) {
  if (!(await isRegistered(telegramId))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return;
  }
  _pendingExportConfirm.set(String(telegramId), { expiresAt: Date.now() + EXPORT_CONFIRM_TTL_MS });
  await sendMessage(telegramId,
    `⚠️ This will reveal your wallet's raw private key in this chat.\n` +
    `Anyone who sees it can steal all funds in this wallet.\n\n` +
    `To confirm, reply with exactly:\n${EXPORT_CONFIRM_PHRASE}\n\n` +
    `This request expires in 60 seconds. Send /cancel to abort now.`
  );
}

async function handleExportKeyConfirmation(telegramId, text) {
  const id = String(telegramId);
  const pending = _pendingExportConfirm.get(id);
  if (!pending) return false;
  _pendingExportConfirm.delete(id);

  if (Date.now() > pending.expiresAt) {
    await sendMessage(telegramId, "Export confirmation expired. Send /exportkey again if you still want to export.");
    return true;
  }
  if (text.trim() !== EXPORT_CONFIRM_PHRASE) {
    await sendMessage(telegramId, "Confirmation phrase did not match exactly. Export cancelled.");
    return true;
  }

  try {
    const { publicKey, secretKeyBase58 } = await exportWalletPrivateKey(id);
    await sendMessage(telegramId,
      `Wallet: ${publicKey}\n` +
      `Private key (base58):\n${secretKeyBase58}\n\n` +
      `⚠️ Delete this message now and never share this key.`
    );
    log("telegram", `[${id}] Private key exported via Telegram`);
  } catch (e) {
    await sendMessage(telegramId, `Export failed: ${e.message}`).catch(() => {});
  }
  return true;
}

async function handlePauseResume(telegramId, enable) {
  const id = String(telegramId);
  if (!(await isRegistered(id))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return;
  }
  await setAgentEnabled(id, enable);
  if (enable) {
    const userConfig = await getUserConfig(id);
    await scheduleUserCycles(id, userConfig);
    await sendMessage(telegramId, "▶️ Agent enabled. Recurring cycles scheduled.").catch(() => {});
  } else {
    await unscheduleUserCycles(id);
    await sendMessage(telegramId, "⏸ Agent disabled. Recurring cycles stopped. Manual commands still work.").catch(() => {});
  }
}

async function handleDryRun(telegramId, argsText) {
  const id = String(telegramId);
  if (!(await isRegistered(id))) {
    await sendMessage(telegramId, "You're not registered yet. Send /start first.");
    return;
  }
  const arg = argsText.trim().toLowerCase();
  if (arg !== "on" && arg !== "off") {
    await sendMessage(telegramId, "Usage: /dryrun on | /dryrun off");
    return;
  }
  await setDryRun(id, arg === "on");
  await sendMessage(telegramId, `Dry-run is now ${arg === "on" ? "ON (no real txs)" : "OFF (live trading — real funds at risk)"}`).catch(() => {});
}

// ─── Long polling ────────────────────────────────────────────────
async function routeMessage(msg, onMessage) {
  const telegramId = msg.from?.id != null ? String(msg.from.id) : null;
  if (!telegramId) return;
  if (!msg.isCallback && msg.chat?.type && msg.chat.type !== "private") return; // group chats not supported

  const user = await getUser(telegramId).catch(() => null);
  if (user?.isBlocked) return;

  const text = String(msg.text || "").trim();

  // Inline-button callbacks for the /config field browser take priority.
  if (msg.isCallback && (msg.callbackData || "").startsWith("cfg:")) {
    await handleConfigCallback(msg, telegramId);
    return;
  }

  // /exportkey confirmation reply takes priority over any other command parsing
  if (_pendingExportConfirm.has(telegramId) && !text.startsWith("/")) {
    if (await handleExportKeyConfirmation(telegramId, text)) return;
  }
  // Pending /config field-edit reply (from tapping a field button)
  if (_pendingConfigEdit.has(telegramId) && !text.startsWith("/")) {
    if (await handleConfigEditSubmission(telegramId, text)) return;
  }
  if (_pendingWalletImport.has(telegramId) && !text.startsWith("/")) {
    const pending = _pendingWalletImport.get(telegramId);
    _pendingWalletImport.delete(telegramId);
    if (Date.now() <= pending.expiresAt) {
      await importWalletFromMessage(telegramId, msg, text);
    } else {
      await deleteIncomingMessage(telegramId, msg?.message_id);
      await sendMessage(telegramId, "Wallet import request expired. Send /addwallet again.");
    }
    return;
  }
  if (text === "/cancel" && (_pendingExportConfirm.has(telegramId) || _pendingConfigEdit.has(telegramId) || _pendingWalletImport.has(telegramId))) {
    _pendingExportConfirm.delete(telegramId);
    _pendingConfigEdit.delete(telegramId);
    _pendingWalletImport.delete(telegramId);
    await sendMessage(telegramId, "Cancelled.").catch(() => {});
    return;
  }

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = (cmdRaw || "").toLowerCase();
  const argsText = rest.join(" ");

  try {
    switch (cmd) {
      case "/start":
        await handleStart(msg, telegramId);
        return;
      case "/help":
        await sendHTML(telegramId, formatHelpText());
        return;
      case "/status":
        await handleStatus(telegramId);
        return;
      case "/wallet":
        await handleWallet(telegramId);
        return;
      case "/wallets":
        await handleWallets(telegramId);
        return;
      case "/addwallet":
        await handleAddWallet(telegramId, msg, argsText);
        return;
      case "/usewallet":
        await handleUseWallet(telegramId, argsText);
        return;
      case "/positions":
        await handlePositions(telegramId);
        return;
      case "/config":
        await handleConfig(telegramId, argsText);
        return;
      case "/exportkey":
        await handleExportKey(telegramId);
        return;
      case "/pause":
        await handlePauseResume(telegramId, false);
        return;
      case "/resume":
        await handlePauseResume(telegramId, true);
        return;
      case "/dryrun":
        await handleDryRun(telegramId, argsText);
        return;
      default:
        break;
    }
  } catch (error) {
    log("telegram_error", `[${telegramId}] Command ${cmd} failed: ${error.message}`);
    await sendMessage(telegramId, `Error: ${error.message}`).catch(() => {});
    return;
  }

  // Anything else (business commands like /deploy, /close, /screen, free-text
  // goals, callback buttons) is forwarded to the caller-supplied handler,
  // wired up by index.js's BullMQ orchestration rewrite.
  if (typeof onMessage === "function") {
    await onMessage(msg, telegramId);
  }
}

async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          };
          await routeMessage(callbackMsg, onMessage);
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        await routeMessage(msg, onMessage);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "start",     description: "Register and create your wallet" },
  { command: "help",      description: "Show commands" },
  { command: "status",    description: "Wallet + positions + agent status" },
  { command: "wallet",    description: "Wallet address + SOL balance" },
  { command: "wallets",   description: "List your wallets" },
  { command: "addwallet", description: "Import another wallet" },
  { command: "usewallet", description: "Select your active wallet" },
  { command: "positions", description: "List open positions" },
  { command: "config",    description: "View/update your config" },
  { command: "dryrun",    description: "Toggle dry-run safety mode" },
  { command: "pause",     description: "Disable your agent" },
  { command: "resume",    description: "Enable your agent" },
  { command: "exportkey", description: "Export your wallet private key" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started (multi-user, open registration)");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers (all require telegramId to route to the right user) ─
export async function notifyDeploy({ telegramId, pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage(telegramId)) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(telegramId,
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ telegramId, pair, pnlUsd, pnlPct }) {
  if (hasActiveLiveMessage(telegramId)) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(telegramId,
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`
  );
}

export async function notifySwap({ telegramId, inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage(telegramId)) return;
  await sendHTML(telegramId,
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ telegramId, pair, minutesOOR }) {
  if (hasActiveLiveMessage(telegramId)) return;
  await sendHTML(telegramId,
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
