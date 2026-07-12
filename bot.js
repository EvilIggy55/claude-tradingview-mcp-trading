/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Market data: Yahoo Finance (stocks), Binance (crypto, falls back to Kraken if geo-blocked)
 * Exchange execution: Kraken REST API (HMAC-SHA512 auth)
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: cron on VPS, runs on schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["API_KEY", "PRIVATE_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Kraken credentials",
        "API_KEY=",
        "PRIVATE_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Kraken credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  kraken: {
    apiKey: process.env.API_KEY,
    privateKey: process.env.PRIVATE_KEY,
    baseUrl: "https://api.kraken.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data ─────────────────────────────────────────────────────────────
// Stocks → Yahoo Finance. Crypto → Binance (falls back to Kraken if geo-blocked)

const isCrypto = (symbol) => /USDT$|BTC$|ETH$|BNB$/i.test(symbol);

async function fetchCandlesYahoo(symbol, interval, limit = 500) {
  const intervalMap = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "1h", "1D": "1d", "1W": "1wk" };
  const yahooInterval = intervalMap[interval] || "1d";
  const range = (yahooInterval === "1d" || yahooInterval === "1wk") ? "2y" : "60d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${yahooInterval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo Finance API error: ${res.status}`);
  const data = await res.json();
  if (data.chart.error) throw new Error(`Yahoo Finance: ${data.chart.error.description}`);
  const result = data.chart.result[0];
  const { open, high, low, close, volume } = result.indicators.quote[0];
  return result.timestamp
    .map((t, i) => ({ time: t * 1000, open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] }))
    .filter((c) => c.close !== null && c.open !== null)
    .slice(-limit);
}

async function fetchCandlesKraken(symbol, interval, limit = 500) {
  // Kraken interval in minutes
  const intervalMap = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1H": 60, "4H": 240, "1D": 1440, "1W": 10080 };
  const minutes = intervalMap[interval] || 60;
  // Kraken pair: BTCUSDT → XBTUSDT, ETHUSDT → ETHUSDT
  const pair = symbol.replace(/^BTC/, "XBT");
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${minutes}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
  const data = await res.json();
  if (data.error && data.error.length) throw new Error(`Kraken: ${data.error[0]}`);
  const key = Object.keys(data.result).find((k) => k !== "last");
  const rows = data.result[key];
  // Kraken returns [time, open, high, low, close, vwap, volume, count]
  return rows.slice(-limit).map((k) => ({
    time: k[0] * 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[6]),
  }));
}

async function fetchCandles(symbol, interval, limit = 500) {
  if (!isCrypto(symbol)) {
    console.log("  Fetching from Yahoo Finance");
    return fetchCandlesYahoo(symbol, interval, limit);
  }
  const intervalMap = { "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" };
  const binanceInterval = intervalMap[interval] || "1m";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (res.status === 451 || res.status === 403) {
      console.log("  Binance geo-blocked — switching to Kraken public API");
      return fetchCandlesKraken(symbol, interval, limit);
    }
    if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
    const data = await res.json();
    return data.map((k) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (err) {
    if (err.message.includes("fetch failed") || err.message.includes("Binance")) {
      console.log("  Binance unreachable — switching to Kraken public API");
      return fetchCandlesKraken(symbol, interval, limit);
    }
    throw err;
  }
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema20, ema50, atr, volume, avgVolume, high20, low20, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > ema20 && ema20 > ema50;
  const bearishBias = price < ema20 && ema20 < ema50;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    check(
      "Price above EMA(20) and EMA(20) above EMA(50) (trend alignment)",
      `price > ${ema20.toFixed(2)}, EMA20 > ${ema50.toFixed(2)}`,
      `price ${price.toFixed(2)}, EMA20 ${ema20.toFixed(2)}`,
      price > ema20 && ema20 > ema50,
    );

    check(
      "Price above 20-period high (breakout triggered)",
      `> ${high20.toFixed(2)}`,
      price.toFixed(2),
      price > high20,
    );

    const volRatio = volume / avgVolume;
    check(
      "Volume > 1.5x 20-period average (institutional participation)",
      "> 1.5x avg",
      `${volRatio.toFixed(2)}x`,
      volRatio > 1.5,
    );

    // Most important rule: not overextended
    const distAboveBreakout = price - high20;
    check(
      "Price within 1x ATR of breakout level (not overextended — most important rule)",
      `< ${atr.toFixed(2)} (1x ATR)`,
      `${distAboveBreakout.toFixed(2)} above breakout`,
      distAboveBreakout < atr,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below EMA(20) and EMA(20) below EMA(50) (trend alignment)",
      `price < ${ema20.toFixed(2)}, EMA20 < ${ema50.toFixed(2)}`,
      `price ${price.toFixed(2)}, EMA20 ${ema20.toFixed(2)}`,
      price < ema20 && ema20 < ema50,
    );

    check(
      "Price below 20-period low (breakdown triggered)",
      `< ${low20.toFixed(2)}`,
      price.toFixed(2),
      price < low20,
    );

    const volRatio = volume / avgVolume;
    check(
      "Volume > 1.5x 20-period average (institutional selling)",
      "> 1.5x avg",
      `${volRatio.toFixed(2)}x`,
      volRatio > 1.5,
    );

    const distBelowBreakout = low20 - price;
    check(
      "Price within 1x ATR of breakdown level (not overextended — most important rule)",
      `< ${atr.toFixed(2)} (1x ATR)`,
      `${distBelowBreakout.toFixed(2)} below breakdown`,
      distBelowBreakout < atr,
    );
  } else {
    console.log("  Bias: NEUTRAL — EMA(20)/EMA(50) not aligned. No trade.\n");
    results.push({
      label: "Market bias",
      required: "EMA(20) > EMA(50) or EMA(20) < EMA(50)",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Kraken Execution ────────────────────────────────────────────────────────

function signKraken(path, postData, nonce) {
  // Kraken signature: HMAC-SHA512(path + SHA256(nonce + postData), base64decode(privateKey))
  const sha256 = crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto
    .createHmac("sha512", Buffer.from(CONFIG.kraken.privateKey, "base64"))
    .update(path + sha256, "binary")
    .digest("base64");
}

async function placeKrakenOrder(symbol, side, sizeUSD, price) {
  // Kraken pair: BTCUSDT → XBTUSDT
  const pair = symbol.replace(/^BTC/, "XBT");
  const volume = (sizeUSD / price).toFixed(8);
  const nonce = Date.now().toString();
  const path = "/0/private/AddOrder";

  const params = new URLSearchParams({
    nonce,
    pair,
    type: side,        // "buy" or "sell"
    ordertype: "market",
    volume,
  });
  const postData = params.toString();
  const signature = signKraken(path, postData, nonce);

  const res = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "API-Key": CONFIG.kraken.apiKey,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postData,
  });

  const data = await res.json();
  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken order failed: ${data.error.join(", ")}`);
  }

  return { orderId: data.result.txid?.[0], description: data.result.descr?.order };
}

// ─── Telegram Notifications ──────────────────────────────────────────────────

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.log(`Telegram notify failed: ${err.message}`);
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Kraken",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(50) + ATR(14)
  const source = isCrypto(CONFIG.symbol) ? "Binance" : "Yahoo Finance";
  console.log(`\n── Fetching market data from ${source} ───────────────────\n`);
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const atr = calcATR(candles, 14);
  const volume = candles[candles.length - 1].volume;
  const prior20 = candles.slice(-21, -1); // 20 candles before current
  const avgVolume = prior20.reduce((sum, c) => sum + c.volume, 0) / prior20.length;
  const high20 = Math.max(...prior20.map((c) => c.high));
  const low20 = Math.min(...prior20.map((c) => c.low));

  console.log(`  EMA(20): $${ema20.toFixed(2)}`);
  console.log(`  EMA(50): $${ema50.toFixed(2)}`);
  console.log(`  ATR(14): $${atr ? atr.toFixed(2) : "N/A"}`);
  console.log(`  Volume:  ${volume.toFixed(2)} (avg ${avgVolume.toFixed(2)})`);
  console.log(`  20-period high: $${high20.toFixed(2)} | low: $${low20.toFixed(2)}`);

  if (!atr) {
    console.log("\n⚠️  Not enough data to calculate ATR. Exiting.");
    return;
  }

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema20, ema50, atr, volume, avgVolume, high20, low20, rules);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema20, ema50, atr, volume, avgVolume, high20, low20 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));

    // Near-breakout alert: price cleared 20D high but only volume is missing
    const bullishBias = price > ema20 && ema20 > ema50;
    const priceAboveBreakout = price > high20;
    const onlyVolumeMissing = bullishBias && priceAboveBreakout &&
      failed.length === 1 && failed[0].includes("Volume");
    if (onlyVolumeMissing) {
      const volRatio = (volume / avgVolume).toFixed(2);
      await sendTelegram(
        `⚠️ <b>${CONFIG.symbol} breakout — waiting on volume</b>\n` +
        `Price: $${price.toFixed(2)} (above 20D high $${high20.toFixed(2)})\n` +
        `Volume: ${volRatio}x avg (need 1.5x)\n` +
        `All other conditions met.`
      );
    }
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      await sendTelegram(
        `📋 <b>PAPER BUY — ${CONFIG.symbol}</b>\n` +
        `Price: $${price.toFixed(2)}\n` +
        `Size: $${tradeSize.toFixed(2)}\n` +
        `All conditions met ✅`
      );
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeKrakenOrder(
          CONFIG.symbol,
          "buy",
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId} (${order.description})`);
        await sendTelegram(
          `🔴 <b>LIVE BUY — ${CONFIG.symbol}</b>\n` +
          `Price: $${price.toFixed(2)}\n` +
          `Size: $${tradeSize.toFixed(2)}\n` +
          `Order: ${order.orderId}`
        );
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
        await sendTelegram(
          `❌ <b>ORDER FAILED — ${CONFIG.symbol}</b>\n` +
          `${err.message}`
        );
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
