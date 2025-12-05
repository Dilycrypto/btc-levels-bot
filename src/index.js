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

// Load Predefined (for validation)
async function loadPredefinedLevels() {
  try {
    const levelsPath = path.join(__dirname, '../data/levels.json');
    const data = JSON.parse(fs.readFileSync(levelsPath, 'utf8'));
    predefinedLevels = data.levels.sort((a, b) => a - b);
    console.log(`Loaded ${predefinedLevels.length} predefined levels for validation`);
  } catch (error) {
    console.warn("No levels.json—skipping validation");
    predefinedLevels = [];
  }
}

// Historical Data Fetch with Cache (last 3 years)
async function getHistoricalBTCData() {
  const now = Date.now();
  if (cachedHistoricalData && lastCacheTime && (now - lastCacheTime) < CACHE_DURATION_MS) {
    console.log('Using cached historical data');
    return cachedHistoricalData;
  }

  const endTime = Math.floor(now / 1000);
  const startTime = endTime - (1095 * 24 * 60 * 60);  // ~3 years
  const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000&toTs=${endTime}&api_key=${process.env.CRYPTOCOMPARE_API_KEY}`;
  try {
    const response = await axios.get(url);
    let data = response.data.Data.Data.map(d => ({
      time: d.time,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volumeto  // Add volume for weighting
    })).reverse();  // Oldest first

    // Filter to last 3 years
    const threeYearsAgo = new Date(now - (3 * 365 * 24 * 60 * 60 * 1000)).getTime() / 1000;
    data = data.filter(d => d.time >= threeYearsAgo);

    cachedHistoricalData = data;
    lastCacheTime = now;
    console.log(`Fetched/cached historical data (${data.length} days, last 3 years)`);
    return data;
  } catch (error) {
    console.error("Error fetching historical data:", error);
    if (cachedHistoricalData) return cachedHistoricalData;
    return null;
  }
}

// Validate Predefined Levels (touches & reversals)
async function validatePredefinedLevels() {
  const historicalData = await getHistoricalBTCData();
  if (!historicalData || predefinedLevels.length === 0) return [];

  const validated = [];
  const tolerance = 0.01;  // 1% zone
  const minTouches = 2;
  const minReversals = 2;

  for (const level of predefinedLevels) {
    let touches = 0;
    let reversals = 0;
    for (let i = 1; i < historicalData.length; i++) {
      const prev = historicalData[i - 1];
      const curr = historicalData[i];
      const low = Math.min(prev.low, curr.low);
      const high = Math.max(prev.high, curr.high);
      // Touch: within zone
      if (low <= level * (1 + tolerance) && high >= level * (1 - tolerance)) {
        touches++;
        // Reversal: close crosses level
        if ((prev.close < level && curr.close > level) || (prev.close > level && curr.close < level)) {
          reversals++;
        }
      }
    }
    if (touches >= minTouches && reversals >= minReversals) {
      validated.push({ level, touches, reversals });
    }
  }

  console.log(`Validated ${validated.length}/${predefinedLevels.length} levels`);
  return validated.sort((a, b) => a.level - b.level);
}

// Calibrate Detection from Validated (average prominence for minProminencePct)
function calibrateFromValidated(validated, historicalData) {
  if (validated.length === 0) return 0.02;  // Tuned default from search

  let totalProminence = 0;
  validated.forEach(({ level }) => {
    // Approx prominence: avg swing around level
    let swings = [];
    for (let i = 0; i < historicalData.length - 1; i++) {
      const curr = historicalData[i];
      if (Math.abs(curr.low - level) / level < 0.02 || Math.abs(curr.high - level) / level < 0.02) {
        const next = historicalData[i + 1];
        swings.push(Math.abs(next.close - curr.close) / level);
      }
    }
    totalProminence += swings.length > 0 ? swings.reduce((a, b) => a + b, 0) / swings.length : 0;
  });

  const avgProminence = totalProminence / validated.length;
  console.log(`Calibrated minProminencePct: ${avgProminence.toFixed(3)} from validated`);
  return Math.max(0.02, avgProminence);  // Min 2%
}

// NEW: Cluster close levels (merge <1% apart)
function clusterLevels(levels, tolerance = 0.01) {
  if (levels.length <= 1) return levels;
  levels.sort((a, b) => a - b);
  const clustered = [];
  let currentCluster = [levels[0]];
  for (let i = 1; i < levels.length; i++) {
    if (Math.abs(levels[i] - currentCluster[currentCluster.length - 1]) / currentCluster[currentCluster.length - 1] <= tolerance) {
      currentCluster.push(levels[i]);
    } else {
      // Average cluster
      const avg = currentCluster.reduce((sum, l) => sum + l, 0) / currentCluster.length;
      clustered.push(avg);
      currentCluster = [levels[i]];
    }
  }
  // Add last cluster
  const avg = currentCluster.reduce((sum, l) => sum + l, 0) / currentCluster.length;
  clustered.push(avg);
  return clustered.sort((a, b) => a - b);
}

// NEW: Volume-weighted filter (prioritize high-volume touches)
function volumeWeightLevels(levels, historicalData) {
  const avgVolume = historicalData.reduce((sum, d) => sum + d.volume, 0) / historicalData.length;
  const weighted = levels.filter(level => {
    let volumeScore = 0;
    for (const day of historicalData) {
      if (Math.abs(day.low - level) / level < 0.01 || Math.abs(day.high - level) / level < 0.01) {
        volumeScore += day.volume;
      }
    }
    return volumeScore >= avgVolume * 2;  // At least 2x avg volume near level
  });
  return weighted;
}

// Dynamic Levels Detection (optimized + clustered + volume-weighted)
async function getDynamicLevels(currentPrice, calibratedProminence) {
  const historicalData = await getHistoricalBTCData();
  if (!historicalData || historicalData.length < 100) {
    return { keyLevels: [], support: null, resistance: null };
  }

  const highs = historicalData.map(d => d.high);
  const lows = historicalData.map(d => d.low);
  const windowSize = 20;  // Optimized from search
  const minDistance = 30;  // Optimized

  // Resistances: local max in highs
  let resistances = [];
  for (let i = windowSize; i < highs.length - windowSize; i++) {
    const slice = highs.slice(i - windowSize, i + windowSize + 1);
    if (highs[i] === Math.max(...slice)) {
      const leftMin = Math.min(...highs.slice(Math.max(0, i - minDistance), i));
      const prominence = (highs[i] - leftMin) / highs[i];
      if (prominence >= calibratedProminence) resistances.push(highs[i]);
    }
  }

  // Supports: local min in lows
  let supports = [];
  for (let i = windowSize; i < lows.length - windowSize; i++) {
    const slice = lows.slice(i - windowSize, i + windowSize + 1);
    if (lows[i] === Math.min(...slice)) {
      const rightMax = Math.max(...highs.slice(i, Math.min(highs.length, i + minDistance)));
      const prominence = (rightMax - lows[i]) / lows[i];
      if (prominence >= calibratedProminence) supports.push(lows[i]);
    }
  }

  // Merge raw
  let allLevels = [...new Set([...supports, ...resistances])];

  // Filter relevant range
  const minLevel = currentPrice * 0.3;
  const maxLevel = currentPrice * 2.5;
  allLevels = allLevels.filter(l => l >= minLevel && l <= maxLevel).sort((a, b) => a - b);

  // NEW: Volume weight
  allLevels = volumeWeightLevels(allLevels, historicalData);

  // NEW: Cluster close ones
  allLevels = clusterLevels(allLevels, 0.01);  // 1% merge tolerance

  const keyLevels = allLevels.slice(0, 20);  // Limit

  // Closest
  let support = supports.filter(s => s < currentPrice).slice(-1)[0] || null;
  let resistance = resistances.filter(r => r > currentPrice)[0] || null;

  console.log(`Optimized Levels - Raw: ${allLevels.length}, Clustered: ${keyLevels.length}, Support: ${support}, Resistance: ${resistance}`);
  return { keyLevels, support, resistance };
}

// Get Current Price (with fallback)
async function getCurrentPrice() {
  // Try CryptoCompare first
  try {
    const url = `https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD&api_key=${process.env.CRYPTOCOMPARE_API_KEY}`;
    const response = await axios.get(url);
    console.log('CryptoCompare API Response:', response.data);  // Debug
    if (response.data.Response === 'Error') throw new Error(response.data.Message);
    const price = response.data.USD;
    console.log(`Current BTC Price (CryptoCompare): $${price}`);
    return price;
  } catch (error) {
    console.error("CryptoCompare failed:", error.message);
  }

  // Fallback: CoinGecko
  try {
    const fallbackUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
    const response = await axios.get(fallbackUrl);
    console.log('CoinGecko API Response:', response.data);  // Debug
    const price = response.data.bitcoin.usd;
    console.log(`Current BTC Price (CoinGecko fallback): $${price}`);
    return price;
  } catch (error) {
    console.error("CoinGecko fallback failed:", error.message);
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
  const welcome = `🚀 *BTC Levels Bot*\n\nTap to validate predefined, calibrate, cluster, and generate independent levels (optimized for similarity).`;
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
    bot.sendMessage(chatId, '⏳ Validating, calibrating & generating optimized levels...');
    const currentPrice = await getCurrentPrice();
    if (!currentPrice) {
      return bot.sendMessage(chatId, '❌ Failed to fetch current price.');
    }

    // Step 1: Validate predefined
    const validated = await validatePredefinedLevels();

    // Step 2: Calibrate
    const historicalData = await getHistoricalBTCData();
    const calibratedProminence = calibrateFromValidated(validated, historicalData);

    // Step 3: Independent detection (optimized)
    const { keyLevels, support, resistance } = await getDynamicLevels(currentPrice, calibratedProminence);

    // Step 4: Similarity (to validated)
    let similarityScore = 0;
    if (validated.length > 0 && keyLevels.length > 0) {
      const tolerance = 0.02;
      const matches = keyLevels.filter(detected => 
        validated.some(v => Math.abs(detected - v.level) / v.level <= tolerance)
      );
      similarityScore = ((matches.length / keyLevels.length) * 100).toFixed(1);
    }

    let response = `📊 *BTC Levels Report* (Price: $${currentPrice.toFixed(2)})\n\n`;
    response += `🎯 *Closest (Independent):*\n`;
    response += `Support: $${support?.toFixed(0) || 'N/A'}\n`;
    response += `Resistance: $${resistance?.toFixed(0) || 'N/A'}\n\n`;

    response += `📈 *Similarity to Validated:* ${similarityScore}% (improved via clustering/volume)\n\n`;

    response += `✅ *Validated Predefined* (${validated.length} high-confidence):\n`;
    if (validated.length > 0) {
      response += validated.slice(0, 10).map(v => `• $${v.level.toFixed(0)} (T:${v.touches}, R:${v.reversals})`).join('\n') + (validated.length > 10 ? `\n... +${validated.length - 10} more` : '');
    } else {
      response += `None met criteria (≥2 touches + ≥2 reversals).`;
    }
    response += `\n\n`;

    response += `🔑 *Independent Key Levels* (optimized, clustered):\n`;
    if (keyLevels.length > 0) {
      response += keyLevels.map(l => `• $${l.toFixed(0)}`).join('\n');
    } else {
      response += `No levels detected.`;
    }

    bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...getKeyboard() });
  } catch (error) {
    console.error("Error:", error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}`, getKeyboard());
  }
});

// Health Ping
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
  await getHistoricalBTCData();  // Pre-warm
  console.log('✅ Bot ready (optimized validation + calibrated mode)');
}

const server = app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  startApp();
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
