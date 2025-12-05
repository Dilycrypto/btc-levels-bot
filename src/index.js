const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Express App (for health on Railway)
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.get('/', (req, res) => res.send('BTC Levels Bot Home'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT1_TOKEN, {
  polling: true
});

// Globals for Levels
let predefinedLevels = [];
let cachedHistoricalData = null;
let lastCacheTime = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;  // 24 hours

// Admin Check
function isAdmin(chatId) {
  const adminIds = process.env.ADMIN_USER_IDS
    ? process.env.ADMIN_USER_IDS.split(',').map(id => id.trim())
    : [];
  return adminIds.includes(chatId.toString());
}

// Load Predefined
async function loadPredefinedLevels() {
  try {
    const levelsPath = path.join(__dirname, '../data/levels.json');
    const data = JSON.parse(fs.readFileSync(levelsPath, 'utf8'));
    predefinedLevels = data.levels.sort((a, b) => a - b);
    console.log(`Loaded ${predefinedLevels.length} predefined levels`);
  } catch (error) {
    console.warn("No levels.json—empty predefined");
    predefinedLevels = [];
  }
}

// Historical Data Fetch with Cache
async function getHistoricalBTCData(daysBack = 730) {
  const now = Date.now();
  if (cachedHistoricalData && lastCacheTime && (now - lastCacheTime) < CACHE_DURATION_MS) {
    console.log('Using cached historical data');
    return cachedHistoricalData;
  }

  const endTime = Math.floor(now / 1000);
  const startTime = endTime - (daysBack * 24 * 60 * 60);
  const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000&toTs=${endTime}&api_key=${process.env.CRYPTOCOMPARE_API_KEY}`;
  try {
    const response = await axios.get(url);
    cachedHistoricalData = response.data.Data.Data.map(d => ({
      time: d.time,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close
    })).reverse();  // Oldest first
    lastCacheTime = now;
    console.log(`Fetched/cached historical data (${cachedHistoricalData.length} days)`);
    return cachedHistoricalData;
  } catch (error) {
    console.error("Error fetching historical data:", error);
    if (cachedHistoricalData) return cachedHistoricalData;
    return null;
  }
}

// Dynamic Levels Detection
async function getDynamicLevels(currentPrice, usePredefined = true) {
  const historicalData = await getHistoricalBTCData();
  if (!historicalData || historicalData.length < 100) {
    console.error("Insufficient data—using empty dynamic");
    return { allSupports: [], allResistances: [], support: null, resistance: null };
  }

  const closes = historicalData.map(d => d.close);
  const windowSize = 20;
  const minProminencePct = 0.02;
  const minDistance = 30;

  // Resistances (maxima)
  let resistances = [];
  for (let i = windowSize; i < closes.length - windowSize; i++) {
    const slice = closes.slice(i - windowSize, i + windowSize + 1);
    if (closes[i] === Math.max(...slice)) {
      const leftMin = Math.min(...closes.slice(Math.max(0, i - minDistance), i));
      const prominence = (closes[i] - leftMin) / closes[i];
      if (prominence >= minProminencePct) resistances.push(closes[i]);
    }
  }

  // Supports (minima)
  let supports = [];
  for (let i = windowSize; i < closes.length - windowSize; i++) {
    const slice = closes.slice(i - windowSize, i + windowSize + 1);
    if (closes[i] === Math.min(...slice)) {
      const rightMax = Math.max(...closes.slice(i, Math.min(closes.length, i + minDistance)));
      const prominence = (rightMax - closes[i]) / closes[i];
      if (prominence >= minProminencePct) supports.push(closes[i]);
    }
  }

  // Recent filter & dedupe
  const recentCloses = closes.slice(-closes.length / 2);
  supports = [...new Set(supports.filter(s => recentCloses.includes(s)))].sort((a, b) => a - b);
  resistances = [...new Set(resistances.filter(r => recentCloses.includes(r)))].sort((a, b) => a - b);

  // Hybrid merge
  let allSupports = supports;
  let allResistances = resistances;
  if (usePredefined && predefinedLevels.length > 0) {
    const tolerance = 0.05;  // 5%
    predefinedLevels.forEach(level => {
      const nearbySupports = supports.filter(s => Math.abs(s - level) / level <= tolerance);
      const nearbyResistances = resistances.filter(r => Math.abs(r - level) / level <= tolerance);
      if (nearbySupports.length === 0) allSupports.push(level);
      if (nearbyResistances.length === 0) allResistances.push(level);
    });
    allSupports = [...new Set(allSupports)].sort((a, b) => a - b);
    allResistances = [...new Set(allResistances)].sort((a, b) => a - b);
  }

  // Limit to top 10
  allSupports = allSupports.slice(-10);
  allResistances = allResistances.slice(0, 10);

  // Closest to current price
  let support = allSupports.filter(s => s < currentPrice).slice(-1)[0] || null;
  let resistance = allResistances.filter(r => r > currentPrice)[0] || null;

  console.log(`Dynamic Levels - Support: ${support}, Resistance: ${resistance}`);
  return { allSupports, allResistances, support, resistance };
}

// Get Current Price (simple fallback to CryptoCompare)
async function getCurrentPrice() {
  try {
    const url = `https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD&api_key=${process.env.CRYPTOCOMPARE_API_KEY}`;
    const response = await axios.get(url);
    const price = response.data.USD;
    console.log(`Current BTC Price: $${price}`);
    return price;
  } catch (error) {
    console.error("Error fetching price:", error);
    return null;
  }
}

// Keyboard
function getKeyboard() {
  return {
    reply_markup: {
      keyboard: [["🔍 Get Dynamic Levels"]],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// Bot Handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    return bot.sendMessage(chatId, '❌ Access restricted to admins');
  }
  const welcome = `🚀 *BTC Levels Bot*\n\nTap to get dynamic support/resistance levels.`;
  bot.sendMessage(chatId, welcome, {
    parse_mode: 'Markdown',
    ...getKeyboard()
  });
});

bot.onText(/🔍 Get Dynamic Levels/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    return bot.sendMessage(chatId, '❌ Access restricted to admins');
  }

  try {
    bot.sendMessage(chatId, '⏳ Fetching levels...');
    const currentPrice = await getCurrentPrice();
    if (!currentPrice) {
      return bot.sendMessage(chatId, '❌ Failed to fetch current price.');
    }

    const { allSupports, allResistances, support, resistance } = await getDynamicLevels(currentPrice, true);

    let response = `📊 *BTC Levels Report* (Price: $${currentPrice.toFixed(2)})\n\n`;
    response += `🎯 *Closest:*\n`;
    response += `Support: $${support || 'N/A'}\n`;
    response += `Resistance: $${resistance || 'N/A'}\n\n`;

    response += `📋 *Predefined Levels (from JSON):*\n`;
    if (predefinedLevels.length > 0) {
      response += predefinedLevels.slice(0, 10).map(l => `• $${l.toFixed(0)}`).join('\n') + (predefinedLevels.length > 10 ? `\n... +${predefinedLevels.length - 10} more` : '');
    } else {
      response += `None loaded.`;
    }
    response += `\n\n`;

    response += `🔄 *Dynamic Levels (Detected + Blended):*\n`;
    response += `Supports:\n${allSupports.map(s => `• $${s.toFixed(0)}`).join('\n') || 'None'}\n\n`;
    response += `Resistances:\n${allResistances.map(r => `• $${r.toFixed(0)}`).join('\n') || 'None'}`;

    bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...getKeyboard() });
  } catch (error) {
    console.error("Error generating levels:", error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}`, getKeyboard());
  }
});

// Health Ping (optional)
async function pingHealthchecks() {
  if (!process.env.HEALTHCHECKS_UUID) return;
  try {
    await axios.get(`https://hc-ping.com/${process.env.HEALTHCHECKS_UUID}`);
    console.log('Health ping sent');
  } catch (error) {
    console.error('Health ping failed:', error.message);
  }
}

setInterval(pingHealthchecks, 300000);  // 5 min

// Startup
async function startApp() {
  await loadPredefinedLevels();
  await getHistoricalBTCData();  // Pre-warm cache
  console.log('✅ Bot ready');
}

const server = app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  startApp();
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
