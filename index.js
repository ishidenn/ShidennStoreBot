require("dotenv").config();
const Discord = require("discord.js");
const fs = require("fs");
const path = require("path");

const client = new Discord.Client({
  intents: ["GUILDS", "GUILD_MEMBERS", "GUILD_MESSAGES"],
});

// ======================
// SETTINGS (EDIT HERE)
// ======================
const RESERVE_DEFAULT_MS = 10 * 60 * 1000; // if method not chosen

// ✅ Your requested timings:
const RESERVE_BY_METHOD_MS = {
  pix: 5 * 60 * 1000,      // 5 min
  paypal: 10 * 60 * 1000,  // 10 min
  crypto: 15 * 60 * 1000,  // 15 min
};

const COOLDOWN_MS = 3000;
const RENAME_CHANNEL_ON_PAID = true;

// Vouches settings
const VOUCHES_FILE = path.join(__dirname, "vouches.json");
const VOUCH_COMMENT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes to type comment
const MAX_VOUCH_COMMENT_LEN = 250; // keep it clean & short

// ======================
// CATALOG (EDIT HERE)
// ======================
const CATALOG = {
  bloodlines: {
    title: "🩸 Bloodlines",
    items: [
      { id: "bl_basic", name: "Basic", stock: 30, price: 25, discountPercent: 20, popular: false },
      { id: "bl_premium", name: "Premium", stock: 12, price: 40, discountPercent: 12, popular: true },
      { id: "bl_full", name: "Full", stock: 7, price: 60, discountPercent: 17, popular: false },
    ],
  },
  gpo: {
    title: "🌊 Grand Piece Online",
    items: [
      { id: "gpo_basic", name: "Basic", stock: 18, price: 30, discountPercent: 17, popular: false },
      { id: "gpo_premium", name: "Premium", stock: 10, price: 55, discountPercent: 18, popular: true },
      { id: "gpo_full", name: "Full", stock: 4, price: 85, discountPercent: 18, popular: false },
    ],
  },
};

// ======================
// Runtime state (memory)
// ======================
// userId -> { shopKey, selectedItemId, qty }
const session = new Map();

// channelId -> order
// {
//   userId, shopKey, itemId, qty,
//   unitPriceFinal, total,
//   reserved: true,
//   reservedUntil: timestamp,
//   reserveTimer: Timeout|null,
//   countdownTimer: Interval|null,
//   method: "pix"|"paypal"|"crypto"|null,
//   orderMessageId: string|null,
//   locked: boolean,     // after method chosen
//   completed: boolean   // after API/staff confirms payment
// }
const channelOrder = new Map();

// stockRemaining key = `${shopKey}:${itemId}` -> number
const stockRemaining = new Map();

// vouch pending: userId -> { stars, channelId, expiresAt }
const pendingVouch = new Map();

// ======================
// Helpers
// ======================
function mustEnv(name) {
  const v = process.env[name];
  if (!v) console.warn(`⚠️ Missing in Secrets/.env: ${name}`);
  return v;
}

function keyStock(shopKey, itemId) {
  return `${shopKey}:${itemId}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function computeFinalPrice(original, discountPercent) {
  const d = clamp(Number(discountPercent || 0), 0, 100);
  return Math.round(Number(original) * (1 - d / 100));
}

function formatBRL(n) {
  return `R$ ${Math.round(n)}`;
}

function divider() {
  return "━━━━━━━━━━━━━━━━━━━━";
}

function shortId(id) {
  return String(id).slice(-4);
}

function lobbyChannelName(userId) {
  return `📌start-here-${shortId(userId)}`;
}

function shopChannelName(shopKey, userId) {
  if (shopKey === "bloodlines") return `🩸bloodlines-${shortId(userId)}`;
  if (shopKey === "gpo") return `🌊grand-piece-online-${shortId(userId)}`;
  return `🛒shop-${shortId(userId)}`;
}

function isManagedChannel(channel) {
  return (
    channel &&
    channel.type === "GUILD_TEXT" &&
    (channel.name.startsWith("📌start-here-") ||
      channel.name.startsWith("🩸bloodlines-") ||
      channel.name.startsWith("🌊grand-piece-online-") ||
      channel.name.startsWith("✅paid-"))
  );
}

function getShopKeyFromChannelName(name) {
  if (name.startsWith("🩸bloodlines-")) return "bloodlines";
  if (name.startsWith("🌊grand-piece-online-")) return "gpo";
  return null;
}

function findPopularOrFirst(shopKey) {
  const items = CATALOG[shopKey].items;
  const p = items.find((x) => x.popular);
  return p ? p.id : items[0]?.id;
}

function getItem(shopKey, itemId) {
  return CATALOG[shopKey].items.find((x) => x.id === itemId);
}

function getRemaining(shopKey, itemId) {
  const k = keyStock(shopKey, itemId);
  return stockRemaining.has(k) ? stockRemaining.get(k) : Number(getItem(shopKey, itemId)?.stock || 0);
}

function setRemaining(shopKey, itemId, value) {
  stockRemaining.set(keyStock(shopKey, itemId), Math.max(0, Number(value || 0)));
}

function initStockFromCatalog() {
  for (const shopKey of Object.keys(CATALOG)) {
    for (const it of CATALOG[shopKey].items) {
      setRemaining(shopKey, it.id, Number(it.stock || 0));
    }
  }
}

function formatMMSS(ms) {
  const safe = Math.max(0, ms);
  const m = Math.floor(safe / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function remainingMs(ts) {
  if (!ts) return 0;
  return Math.max(0, ts - Date.now());
}

function isStaffMember(member) {
  const staffRoleId = process.env.STAFF_ROLE_ID;
  return !!(staffRoleId && member?.roles?.cache?.has(staffRoleId));
}

function starsLine(n) {
  const full = "⭐".repeat(Math.max(0, Math.min(5, n)));
  const empty = "☆".repeat(5 - Math.max(0, Math.min(5, n)));
  return full + empty;
}

function randRef(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ======================
// VOUCHES (ANONYMOUS JSON)
// ======================
function ensureVouchesFile() {
  try {
    if (!fs.existsSync(VOUCHES_FILE)) fs.writeFileSync(VOUCHES_FILE, "[]", "utf8");
  } catch {}
}
function loadVouches() {
  try {
    ensureVouchesFile();
    const raw = fs.readFileSync(VOUCHES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveVouches(list) {
  try {
    ensureVouchesFile();
    fs.writeFileSync(VOUCHES_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch {}
}

// ======================
// UI Components
// ======================
function mainMenuRow() {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageButton().setCustomId("buy_bloodlines").setLabel("🩸 Bloodlines").setStyle("DANGER"),
    new Discord.MessageButton().setCustomId("buy_gpo").setLabel("🌊 Grand Piece Online").setStyle("PRIMARY"),
    new Discord.MessageButton().setCustomId("call_staff").setLabel("🆘 Contact Support").setStyle("SUCCESS")
  );
}

function infoRow() {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageButton().setCustomId("shidenn_about").setLabel("📌 What is Shidenn Store?").setStyle("SECONDARY"),
    new Discord.MessageButton().setCustomId("shidenn_vouches").setLabel("⭐ View Vouches").setStyle("SUCCESS")
  );
}

function backRow() {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageButton().setCustomId("back_to_start").setLabel("⬅ Back to Start Here").setStyle("SECONDARY"),
    new Discord.MessageButton().setCustomId("call_staff").setLabel("🆘 Contact Support").setStyle("SUCCESS")
  );
}

function qtyRow() {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageButton().setCustomId("qty_minus").setLabel("➖").setStyle("SECONDARY"),
    new Discord.MessageButton().setCustomId("qty_plus").setLabel("➕").setStyle("SECONDARY"),
    new Discord.MessageButton().setCustomId("confirm_item").setLabel("✅ Confirm").setStyle("SUCCESS")
  );
}

// ✅ NO "I HAVE PAID" button anymore
function paymentMethodsRow(disabled = false) {
  const btn = (id, label) =>
    new Discord.MessageButton().setCustomId(id).setLabel(label).setStyle("SECONDARY").setDisabled(disabled);

  return new Discord.MessageActionRow().addComponents(
    btn("pay_pix", "🇧🇷 PIX"),
    btn("pay_paypal", "🅿️ PayPal"),
    btn("pay_crypto", "₿ Crypto (Bitso)")
  );
}

function cancelRow(disabled = false) {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageButton()
      .setCustomId("cancel_order")
      .setLabel("🗑 Cancel Order")
      .setStyle("DANGER")
      .setDisabled(disabled)
  );
}

function staffRow() {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageButton().setCustomId("mark_paid").setLabel("✅ Mark as Paid (Staff)").setStyle("SUCCESS")
  );
}

function itemSelectRow(shopKey, selectedItemId, disabled = false) {
  const options = CATALOG[shopKey].items.map((it) => {
    const original = Number(it.price);
    const disc = Number(it.discountPercent || 0);
    const final = computeFinalPrice(original, disc);
    const remaining = getRemaining(shopKey, it.id);

    return {
      label: it.name,
      value: it.id,
      description: `Stock: ${remaining} | ${formatBRL(final)}${disc > 0 ? ` (-${disc}%)` : ""}${
        it.popular ? " | MOST POPULAR" : ""
      }`,
      default: it.id === selectedItemId,
      emoji: it.popular ? "🔥" : undefined,
    };
  });

  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageSelectMenu()
      .setCustomId("select_item")
      .setPlaceholder(disabled ? "Locked (cancel order to change)" : "Select a product…")
      .setDisabled(disabled)
      .addOptions(options.slice(0, 25))
  );
}

function vouchCountSelectRow() {
  return new Discord.MessageActionRow().addComponents(
    new Discord.MessageSelectMenu()
      .setCustomId("vouch_count")
      .setPlaceholder("How many vouches do you want to see?")
      .addOptions([
        { label: "Up to 5 vouches", value: "5", description: "Show the latest 5 anonymous vouches" },
        { label: "Up to 10 vouches", value: "10", description: "Show the latest 10 anonymous vouches" },
        { label: "Up to 100 vouches", value: "100", description: "Show the latest 100 anonymous vouches" },
      ])
  );
}

function vouchStarsRow() {
  const mk = (n) =>
    new Discord.MessageButton()
      .setCustomId(`vouch_star_${n}`)
      .setLabel(`${"⭐".repeat(n)}`)
      .setStyle(n >= 4 ? "SUCCESS" : n === 3 ? "PRIMARY" : "SECONDARY");

  return new Discord.MessageActionRow().addComponents(mk(1), mk(2), mk(3), mk(4), mk(5));
}

// ======================
// Catalog Embed (all items listed)
// ======================
function buildCatalogEmbed(shopKey, selectedItemId, qty) {
  const shop = CATALOG[shopKey];
  const items = shop.items;

  const selected = getItem(shopKey, selectedItemId) || items[0];
  const remainingSelected = getRemaining(shopKey, selected.id);

  const unitOriginal = Number(selected.price);
  const d = Number(selected.discountPercent || 0);
  const unitFinal = computeFinalPrice(unitOriginal, d);

  const maxQty = Math.max(0, remainingSelected);
  const safeQty = clamp(qty, 1, Math.max(1, maxQty));
  const total = unitFinal * safeQty;

  const lines = items.map((it, idx) => {
    const original = Number(it.price);
    const disc = Number(it.discountPercent || 0);
    const final = computeFinalPrice(original, disc);
    const popular = it.popular ? " 🔥" : "";
    const selectedMark = it.id === selectedItemId ? "✅" : "▫️";
    const remaining = getRemaining(shopKey, it.id);

    const priceLine =
      disc > 0 ? `~~${formatBRL(original)}~~ → **${formatBRL(final)}** (-${disc}%)` : `**${formatBRL(final)}**`;

    return `${selectedMark} **${idx + 1}. ${it.name}**${popular}\n   Stock: **${remaining}** | ${priceLine}`;
  });

  const embed = new Discord.MessageEmbed()
    .setTitle(`${shop.title} — Catalog`)
    .setDescription(`${divider()}\n${lines.join("\n\n")}\n${divider()}`)
    .addField(
      "Selected",
      `**${selected.name}**\nStock: **${remainingSelected}**\nUnit: **${formatBRL(unitFinal)}**`,
      true
    )
    .addField("Quantity", `**${safeQty}**`, true)
    .addField("Total", `**${formatBRL(total)}**`, true)
    .setFooter("Pick item, adjust quantity, then Confirm to reserve stock.");

  return { embed, safeQty, unitFinal, total, remainingSelected };
}

// ======================
// Channel management
// ======================
async function createPrivateChannel({ guild, name, parentCategoryId, staffRoleId, isoladoRoleId, userId }) {
  return guild.channels.create(name, {
    type: "GUILD_TEXT",
    parent: parentCategoryId,
    permissionOverwrites: [
      { id: guild.id, deny: ["VIEW_CHANNEL"] },
      { id: isoladoRoleId, deny: ["VIEW_CHANNEL"] },
      { id: userId, allow: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"] },
      { id: staffRoleId, deny: ["VIEW_CHANNEL"] }, // staff only sees after requested/paid
    ],
  });
}

async function findUserChannelByPrefix(guild, userId, prefix) {
  return (
    guild.channels.cache.find((ch) => {
      if (!ch || ch.type !== "GUILD_TEXT") return false;
      if (!ch.name.startsWith(prefix)) return false;
      return ch.permissionOverwrites?.cache?.has(userId);
    }) || null
  );
}

async function findLobby(guild, userId) {
  return findUserChannelByPrefix(guild, userId, "📌start-here-");
}

async function findShop(guild, userId, shopKey) {
  const prefix = shopKey === "bloodlines" ? "🩸bloodlines-" : "🌊grand-piece-online-";
  return findUserChannelByPrefix(guild, userId, prefix);
}

async function hideForUser(channel, userId) {
  await channel.permissionOverwrites.edit(userId, { VIEW_CHANNEL: false }).catch(() => {});
}

async function showForUser(channel, userId) {
  await channel.permissionOverwrites.edit(userId, {
    VIEW_CHANNEL: true,
    SEND_MESSAGES: true,
    READ_MESSAGE_HISTORY: true,
  }).catch(() => {});
}

// ======================
// Reservation + live countdown
// ======================
function clearReserveTimer(order) {
  if (order?.reserveTimer) {
    clearTimeout(order.reserveTimer);
    order.reserveTimer = null;
  }
}
function clearCountdownTimer(order) {
  if (order?.countdownTimer) {
    clearInterval(order.countdownTimer);
    order.countdownTimer = null;
  }
}

async function fetchOrderMessage(guild, channelId, messageId) {
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return null;
    return await ch.messages.fetch(messageId).catch(() => null);
  } catch {
    return null;
  }
}

function releaseReservation(channelId, reason = "expired") {
  const order = channelOrder.get(channelId);
  if (!order || !order.reserved || order.completed) return null;

  const { shopKey, itemId, qty } = order;

  // return stock
  const current = getRemaining(shopKey, itemId);
  setRemaining(shopKey, itemId, current + qty);

  clearReserveTimer(order);
  clearCountdownTimer(order);

  channelOrder.delete(channelId);
  return { shopKey, itemId, qty, reason };
}

async function notifyReservationReleased(guild, channelId) {
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    await ch.send(
      `⏳ **Reservation expired**\nReserved stock was returned.\nOpen the catalog again and confirm a new order.`
    );
  } catch {}
}

function startReservationTimersOnce(guild, channelId, ms) {
  const order = channelOrder.get(channelId);
  if (!order) return;

  // do not restart if already running
  if (order.reservedUntil && order.reserveTimer && order.countdownTimer) return;

  order.reservedUntil = Date.now() + ms;

  clearReserveTimer(order);
  order.reserveTimer = setTimeout(async () => {
    const released = releaseReservation(channelId, "expired");
    if (released) await notifyReservationReleased(guild, channelId);
  }, ms);

  channelOrder.set(channelId, order);
}

function startLiveCountdownOnce(guild, channelId) {
  const order = channelOrder.get(channelId);
  if (!order) return;
  if (order.countdownTimer) return;

  order.countdownTimer = setInterval(async () => {
    const o = channelOrder.get(channelId);
    if (!o || !o.reserved || o.completed || !o.orderMessageId || !o.reservedUntil) {
      if (o) clearCountdownTimer(o);
      return;
    }

    const msLeft = o.reservedUntil - Date.now();
    if (msLeft <= 0) {
      clearCountdownTimer(o);
      return;
    }

    const msg = await fetchOrderMessage(guild, channelId, o.orderMessageId);
    if (!msg) return;

    const time = formatMMSS(msLeft);
    const updated = msg.content.replace(
      /⏳ Reservation expires in \*\*\d{2}:\d{2}\*\*/g,
      `⏳ Reservation expires in **${time}**`
    );

    if (updated !== msg.content) {
      await msg.edit({ content: updated }).catch(() => {});
    }
  }, 1000);

  channelOrder.set(channelId, order);
}

// ======================
// VOUCH FLOW (interactive stars + comment)
// ======================
async function promptVouch(guild, channelId, userId) {
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    await ch.send({
      content:
        `⭐ **Rate your experience (anonymous)**\n` +
        `Click a star below (1–5). Then you'll type a short comment.\n` +
        `No username / ID will be shown publicly.`,
      components: [vouchStarsRow()],
    });
  } catch {}
}

async function collectVouchComment(channel, userId, stars) {
  pendingVouch.set(userId, { stars, channelId: channel.id, expiresAt: Date.now() + VOUCH_COMMENT_TIMEOUT_MS });

  await channel.send(
    `📝 **Type your comment now** (max ${MAX_VOUCH_COMMENT_LEN} chars).\n` +
    `You have **${Math.floor(VOUCH_COMMENT_TIMEOUT_MS / 60000)} minutes**.\n` +
    `Type \`cancel\` to abort.`
  );

  const filter = (m) => m.author.id === userId && m.channel.id === channel.id;

  const collector = channel.createMessageCollector({ filter, time: VOUCH_COMMENT_TIMEOUT_MS, max: 1 });

  return new Promise((resolve) => {
    collector.on("collect", (m) => resolve({ ok: true, message: m }));
    collector.on("end", (collected) => {
      if (!collected || collected.size === 0) resolve({ ok: false, message: null });
    });
  });
}

function addAnonymousVouch(stars, comment) {
  const list = loadVouches();
  list.unshift({
    stars: clamp(Number(stars), 1, 5),
    comment: String(comment).slice(0, MAX_VOUCH_COMMENT_LEN),
    at: Date.now(),
    ref: randRef(4),
  });
  saveVouches(list);
}

function buildVouchesEmbed(limit) {
  const list = loadVouches().slice(0, limit);

  const embed = new Discord.MessageEmbed()
    .setTitle(`⭐ Anonymous Vouches (Latest ${Math.min(limit, list.length)})`)
    .setDescription(
      list.length
        ? list
            .map((v, i) => {
              const when = new Date(v.at).toLocaleString("en-US");
              return `**${i + 1}.** ${starsLine(v.stars)}  \`#${v.ref}\`\n> ${v.comment}\n🕒 ${when}`;
            })
            .join("\n\n")
        : "No vouches yet."
    )
    .setFooter("Shidenn Store • Anonymous reviews");

  return embed;
}

// ======================
// ✅ PAYMENT CONFIRMED HOOK (CALL THIS AFTER API CONFIRMS)
// ======================
async function onPaymentConfirmed(guild, channelId, details = {}) {
  const order = channelOrder.get(channelId);
  if (!order || order.completed !== false || !order.reserved) return;

  order.completed = true;
  clearReserveTimer(order);
  clearCountdownTimer(order);
  channelOrder.set(channelId, order);

  const it = getItem(order.shopKey, order.itemId);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // allow staff to enter now
  await channel.permissionOverwrites.edit(process.env.STAFF_ROLE_ID, {
    VIEW_CHANNEL: true,
    SEND_MESSAGES: true,
    READ_MESSAGE_HISTORY: true,
  }).catch(() => {});

  const tx = details.txId ? `\nTX: **${details.txId}**` : "";
  const method = order.method ? order.method.toUpperCase() : "UNKNOWN";

  await channel.send(
    `✅ **Payment Confirmed**\n` +
    `Method: **${method}**${tx}\n` +
    `Order: **${CATALOG[order.shopKey].title} — ${it?.name || "Unknown"}**\n` +
    `Qty: **${order.qty}** | Total: **${formatBRL(order.total)}**\n` +
    `🔔 <@&${process.env.STAFF_ROLE_ID}> please assist.`
  );

  if (RENAME_CHANNEL_ON_PAID) {
    const suffix = shortId(order.userId).toLowerCase();
    await channel.setName(`✅paid-${suffix}`.slice(0, 90)).catch(() => {});
  }

  // ⭐ Prompt anonymous vouch after payment confirmed
  await promptVouch(guild, channelId, order.userId);
}

// ======================
// Cooldown
// ======================
const cooldownMap = new Map();
function isOnCooldown(userId) {
  const now = Date.now();
  const last = cooldownMap.get(userId) || 0;
  if (now - last < COOLDOWN_MS) return true;
  cooldownMap.set(userId, now);
  return false;
}

const COOLDOWN_KEYS = new Set([
  "buy_bloodlines",
  "buy_gpo",
  "call_staff",
  "back_to_start",
  "qty_minus",
  "qty_plus",
  "confirm_item",
  "pay_pix",
  "pay_paypal",
  "pay_crypto",
  "cancel_order",
  "mark_paid",
  "shidenn_about",
  "shidenn_vouches",
]);

// ======================
// Ready
// ======================
client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  mustEnv("TOKEN");
  mustEnv("CATEGORY_ID");
  mustEnv("STAFF_ROLE_ID");
  mustEnv("ISOLADO_ROLE_ID");

  ensureVouchesFile();
  initStockFromCatalog();
  console.log("📦 Stock initialized from catalog.");
});

// ======================
// Join -> Start Here
// ======================
client.on("guildMemberAdd", async (member) => {
  try {
    const CATEGORY_ID = mustEnv("CATEGORY_ID");
    const STAFF_ROLE_ID = mustEnv("STAFF_ROLE_ID");
    const ISOLADO_ROLE_ID = mustEnv("ISOLADO_ROLE_ID");

    await member.roles.add(ISOLADO_ROLE_ID).catch(() => {});

    const lobby = await createPrivateChannel({
      guild: member.guild,
      name: lobbyChannelName(member.id),
      parentCategoryId: CATEGORY_ID,
      staffRoleId: STAFF_ROLE_ID,
      isoladoRoleId: ISOLADO_ROLE_ID,
      userId: member.id,
    });

    await lobby.setTopic("📌 start here — private automated support").catch(() => {});
    await lobby.send({
      content: `📌 **Start Here**\n\nChoose an option below:`,
      components: [mainMenuRow(), infoRow()],
    });
  } catch (err) {
    console.error("❌ ERROR in guildMemberAdd:", err);
  }
});

// ======================
// Interactions
// ======================
client.on("interactionCreate", async (interaction) => {
  try {
    const userId = interaction.user.id;
    const channel = interaction.channel;

    // Cooldown on spam clicks
    if (interaction.isButton() && COOLDOWN_KEYS.has(interaction.customId) && isOnCooldown(userId)) {
      return interaction.reply({ content: "⏳ Please wait 3 seconds before clicking again.", ephemeral: true });
    }

    // ==========
    // About button (works anywhere)
    // ==========
    if (interaction.isButton() && interaction.customId === "shidenn_about") {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

      const embed = new Discord.MessageEmbed()
        .setTitle("📌 What is Shidenn Store?")
        .setDescription(
          "**Shidenn Store** is the first Roblox marketplace built to be **100% anonymous**.\n\n" +
          "We focus on **fast delivery**, **transparent deals**, and **anonymous vouches**.\n" +
          "Need help? Click **Contact Support**."
        )
        .setFooter("Shidenn Store");

      return interaction.editReply({ embeds: [embed] });
    }

    // ==========
    // View vouches button (works anywhere)
    // ==========
    if (interaction.isButton() && interaction.customId === "shidenn_vouches") {
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

      return interaction.editReply({
        content: "Select how many anonymous vouches you want to view:",
        components: [vouchCountSelectRow()],
      });
    }

    // Select how many vouches
    if (interaction.isSelectMenu() && interaction.customId === "vouch_count") {
      const n = Number(interaction.values?.[0] || "5");
      const limit = n === 100 ? 100 : n === 10 ? 10 : 5;

      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

      const embed = buildVouchesEmbed(limit);
      return interaction.editReply({ content: "", embeds: [embed], components: [] });
    }

    // ==========
    // Vouch stars (only buyer in that channel should do it)
    // ==========
    if (interaction.isButton() && interaction.customId.startsWith("vouch_star_")) {
      const stars = Number(interaction.customId.split("_").pop());
      if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

      // Only allow if there is an order in this channel and user is the buyer
      const order = channelOrder.get(channel.id);
      if (!order || !order.completed) {
        return interaction.editReply({ content: "⚠️ You can only vouch after a completed order." });
      }
      if (order.userId !== userId) {
        return interaction.editReply({ content: "⚠️ Only the buyer can leave a vouch in this channel." });
      }

      // prevent spam: if already pending, block
      const pending = pendingVouch.get(userId);
      if (pending && pending.channelId === channel.id && pending.expiresAt > Date.now()) {
        return interaction.editReply({ content: "📝 You already started a vouch. Please type your comment in chat." });
      }

      // Ask for comment in chat
      await interaction.editReply({ content: `✅ You selected: **${stars} stars**. Check the channel to type your comment.` });

      const result = await collectVouchComment(channel, userId, stars);

      pendingVouch.delete(userId);

      if (!result.ok || !result.message) {
        return channel.send("⏳ Vouch timed out. You can click the stars again anytime.");
      }

      const text = String(result.message.content || "").trim();
      if (!text || text.toLowerCase() === "cancel") {
        return channel.send("❌ Vouch cancelled.");
      }

      const cleaned = text.slice(0, MAX_VOUCH_COMMENT_LEN);
      addAnonymousVouch(stars, cleaned);

      return channel.send(
        `✅ **Anonymous vouch saved!**\n` +
        `Rating: ${starsLine(stars)}\n` +
        `Comment: "${cleaned}"`
      );
    }

    // ==========
    // From here: only inside managed private channels
    // ==========
    if (!isManagedChannel(channel)) {
      return interaction.reply({ content: "Use this inside your private channels.", ephemeral: true });
    }

    const isStaff = interaction.member?.roles?.cache?.has(process.env.STAFF_ROLE_ID);
    const isOwner = interaction.guild && interaction.guild.ownerId === userId;
    const isAdmin = interaction.member?.permissions?.has("ADMINISTRATOR");
    const isChannelOwner = channel.permissionOverwrites?.cache?.has(userId);

    if (!isStaff && !isOwner && !isAdmin && !isChannelOwner) {
      return interaction.reply({ content: "You don't have permission to use this.", ephemeral: true });
    }

    const existingOrder = channelOrder.get(channel.id);

    // Contact Support
    if (interaction.isButton() && interaction.customId === "call_staff") {
      await channel.permissionOverwrites.edit(process.env.STAFF_ROLE_ID, {
        VIEW_CHANNEL: true,
        SEND_MESSAGES: true,
        READ_MESSAGE_HISTORY: true,
      });
      await channel.send(`🔔 <@&${process.env.STAFF_ROLE_ID}> **Support requested** in this channel.`);
      return interaction.reply({ content: "✅ Support notified.", ephemeral: true });
    }

    // Back to Start Here
    if (interaction.isButton() && interaction.customId === "back_to_start") {
      await interaction.deferReply({ ephemeral: true });
      const lobby = await findLobby(interaction.guild, userId);
      if (!lobby) return interaction.editReply({ content: "⚠️ Start Here not found." });

      await showForUser(lobby, userId);

      if (channel.name.startsWith("🩸bloodlines-") || channel.name.startsWith("🌊grand-piece-online-")) {
        await hideForUser(channel, userId);
      }

      await lobby.send({ content: "🏠 **Main Menu**", components: [mainMenuRow(), infoRow()] }).catch(() => {});
      return interaction.editReply({ content: `✅ Back: ${lobby}` });
    }

    // Open shop
    if (interaction.isButton() && (interaction.customId === "buy_bloodlines" || interaction.customId === "buy_gpo")) {
      await interaction.deferReply({ ephemeral: true });

      const shopKey = interaction.customId === "buy_bloodlines" ? "bloodlines" : "gpo";

      let shop = await findShop(interaction.guild, userId, shopKey);
      if (!shop) {
        shop = await createPrivateChannel({
          guild: interaction.guild,
          name: shopChannelName(shopKey, userId),
          parentCategoryId: process.env.CATEGORY_ID,
          staffRoleId: process.env.STAFF_ROLE_ID,
          isoladoRoleId: process.env.ISOLADO_ROLE_ID,
          userId,
        });
        await shop.setTopic(`${CATALOG[shopKey].title} — private shop`).catch(() => {});
      }

      const lobby = await findLobby(interaction.guild, userId);
      if (lobby) await hideForUser(lobby, userId);

      const selectedItemId = findPopularOrFirst(shopKey);
      const qty = 1;
      session.set(userId, { shopKey, selectedItemId, qty });

      await shop.send({
        embeds: [buildCatalogEmbed(shopKey, selectedItemId, qty).embed],
        components: [itemSelectRow(shopKey, selectedItemId, false), qtyRow(), backRow()],
      });

      return interaction.editReply({ content: `✅ Opened: ${shop}` });
    }

    // Select item (blocked if active order exists)
    if (interaction.isSelectMenu() && interaction.customId === "select_item") {
      if (existingOrder && existingOrder.reserved && !existingOrder.completed) {
        return interaction.reply({
          content: "🔒 You have an active reserved order. **Cancel Order** to change item/qty/method.",
          ephemeral: true,
        });
      }

      const s = session.get(userId);
      if (!s) return interaction.reply({ content: "⚠️ Session not found. Open the shop again.", ephemeral: true });

      const shopKey = getShopKeyFromChannelName(channel.name) || s.shopKey;
      const selectedItemId = interaction.values?.[0];

      const it = getItem(shopKey, selectedItemId);
      if (!it) return interaction.reply({ content: "⚠️ Item not found.", ephemeral: true });

      const maxQty = Math.max(0, getRemaining(shopKey, it.id));
      s.shopKey = shopKey;
      s.selectedItemId = selectedItemId;
      s.qty = clamp(s.qty || 1, 1, Math.max(1, maxQty));
      session.set(userId, s);

      const built = buildCatalogEmbed(shopKey, s.selectedItemId, s.qty);

      return interaction.update({
        embeds: [built.embed],
        components: [itemSelectRow(shopKey, s.selectedItemId, false), qtyRow(), backRow()],
      });
    }

    // Qty + Confirm (blocked if active order exists)
    if (interaction.isButton() && ["qty_minus", "qty_plus", "confirm_item"].includes(interaction.customId)) {
      if (existingOrder && existingOrder.reserved && !existingOrder.completed) {
        return interaction.reply({
          content: "🔒 You already have an active reserved order. **Cancel Order** to change it.",
          ephemeral: true,
        });
      }

      const s = session.get(userId);
      if (!s) return interaction.reply({ content: "⚠️ Session not found. Open the shop again.", ephemeral: true });

      const shopKey = getShopKeyFromChannelName(channel.name) || s.shopKey;
      const it = getItem(shopKey, s.selectedItemId);
      if (!it) return interaction.reply({ content: "⚠️ Item not found.", ephemeral: true });

      const remaining = getRemaining(shopKey, it.id);
      const maxQty = Math.max(0, remaining);

      if (interaction.customId === "qty_minus") s.qty = clamp((s.qty || 1) - 1, 1, Math.max(1, maxQty));
      if (interaction.customId === "qty_plus") s.qty = clamp((s.qty || 1) + 1, 1, Math.max(1, maxQty));

      if (interaction.customId === "confirm_item") {
        const qty = clamp(s.qty || 1, 1, 999);
        const currentRemaining = getRemaining(shopKey, it.id);

        if (currentRemaining <= 0) return interaction.reply({ content: "❌ Out of stock.", ephemeral: true });
        if (qty > currentRemaining)
          return interaction.reply({ content: `❌ Not enough stock. Available: ${currentRemaining}`, ephemeral: true });

        // reserve stock
        setRemaining(shopKey, it.id, currentRemaining - qty);

        const unitFinal = computeFinalPrice(Number(it.price), Number(it.discountPercent || 0));
        const total = unitFinal * qty;

        const order = {
          userId,
          shopKey,
          itemId: it.id,
          qty,
          unitPriceFinal: unitFinal,
          total,
          reserved: true,
          reservedUntil: null,
          reserveTimer: null,
          countdownTimer: null,
          method: null,
          orderMessageId: null,
          locked: false,
          completed: false,
        };

        channelOrder.set(channel.id, order);

        startReservationTimersOnce(interaction.guild, channel.id, RESERVE_DEFAULT_MS);

        const initialTime = formatMMSS(remainingMs(channelOrder.get(channel.id).reservedUntil));

        const orderMsg = await channel.send({
          content:
            `🧾 **Order Confirmed + Stock Reserved**\n` +
            `Item: **${CATALOG[shopKey].title} — ${it.name}**\n` +
            `Qty: **${qty}** | Unit: **${formatBRL(unitFinal)}** | Total: **${formatBRL(total)}**\n\n` +
            `⏳ Reservation expires in **${initialTime}**\n\n` +
            `Choose payment method below.\n` +
            `After payment, the bot will confirm automatically.\n` +
            `To change anything: **Cancel Order**.`,
          components: [paymentMethodsRow(false), cancelRow(false), staffRow(), backRow()],
        });

        const o = channelOrder.get(channel.id);
        o.orderMessageId = orderMsg.id;
        channelOrder.set(channel.id, o);

        startLiveCountdownOnce(interaction.guild, channel.id);

        return interaction.reply({ content: "✅ Reserved successfully.", ephemeral: true });
      }

      session.set(userId, s);
      const built = buildCatalogEmbed(shopKey, s.selectedItemId, s.qty);

      return interaction.update({
        embeds: [built.embed],
        components: [itemSelectRow(shopKey, s.selectedItemId, false), qtyRow(), backRow()],
      });
    }

    // Cancel Order
    if (interaction.isButton() && interaction.customId === "cancel_order") {
      const order = channelOrder.get(channel.id);
      if (!order || !order.reserved) return interaction.reply({ content: "⚠️ No active reservation.", ephemeral: true });
      if (order.completed) return interaction.reply({ content: "✅ Order already completed.", ephemeral: true });

      if (order.userId !== userId && !isStaff && !isAdmin && !isOwner) {
        return interaction.reply({ content: "❌ You can't cancel someone else's order.", ephemeral: true });
      }

      const released = releaseReservation(channel.id, "canceled");
      if (released) {
        const it = getItem(released.shopKey, released.itemId);
        await channel.send(
          `🗑 **Order canceled** — reservation released back to stock.\n` +
            `Item: **${CATALOG[released.shopKey].title} — ${it?.name || released.itemId}** | Qty: **${released.qty}**`
        );
      }
      return interaction.reply({ content: "✅ Order canceled.", ephemeral: true });
    }

    // Payment method selection (LOCK)
    if (interaction.isButton() && ["pay_pix", "pay_paypal", "pay_crypto"].includes(interaction.customId)) {
      const order = channelOrder.get(channel.id);
      if (!order || !order.reserved) return interaction.reply({ content: "⚠️ No reserved order.", ephemeral: true });
      if (order.completed) return interaction.reply({ content: "✅ Order already completed.", ephemeral: true });
      if (order.userId !== userId && !isStaff && !isAdmin && !isOwner) {
        return interaction.reply({ content: "❌ This order belongs to another user.", ephemeral: true });
      }

      const chosen =
        interaction.customId === "pay_pix" ? "pix" :
        interaction.customId === "pay_paypal" ? "paypal" :
        "crypto";

      if (order.locked) {
        if (order.method === chosen) {
          return interaction.reply({
            content: `✅ Method already selected: **${order.method.toUpperCase()}**.\n⏳ Time left: **${formatMMSS(remainingMs(order.reservedUntil))}**.`,
            ephemeral: true,
          });
        }
        return interaction.reply({
          content: `🔒 Method locked to **${order.method.toUpperCase()}**. Cancel order to change.`,
          ephemeral: true,
        });
      }

      order.method = chosen;
      order.locked = true;

      // Apply method timing ONCE (and prevent “spam reset”):
      const methodMs = RESERVE_BY_METHOD_MS[chosen] || RESERVE_DEFAULT_MS;
      const nowLeft = remainingMs(order.reservedUntil);

      // Fairness:
      // - PIX/PayPal: do NOT extend (no abuse)
      // - Crypto: if remaining is less than 15min, extend once to 15min
      if (chosen === "crypto" && nowLeft < methodMs) {
        order.reservedUntil = Date.now() + methodMs;
        clearReserveTimer(order);
        order.reserveTimer = setTimeout(async () => {
          const released = releaseReservation(channel.id, "expired");
          if (released) await notifyReservationReleased(interaction.guild, channel.id);
        }, methodMs);
      }

      channelOrder.set(channel.id, order);

      await channel.send(
        `💳 **Payment Method Selected (Locked): ${chosen.toUpperCase()}**\n` +
        `⏳ Time left: **${formatMMSS(remainingMs(order.reservedUntil))}**\n` +
        `Waiting for **automatic confirmation** from the payment API...`
      );

      return interaction.reply({ content: `🔒 Method set to ${chosen.toUpperCase()} (locked).`, ephemeral: true });
    }

    // Staff button: Mark as Paid (manual fallback)
    if (interaction.isButton() && interaction.customId === "mark_paid") {
      if (!isStaff && !isAdmin && !isOwner) return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

      await onPaymentConfirmed(interaction.guild, channel.id, { txId: "MANUAL_STAFF_CONFIRM" });
      return interaction.reply({ content: "✅ Marked as paid.", ephemeral: true });
    }
  } catch (err) {
    console.error("❌ ERROR:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "⚠️ Something went wrong.", ephemeral: true });
      }
    } catch {}
  }
});

client.login(process.env.TOKEN);
