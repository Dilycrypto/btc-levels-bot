# BTC Levels Bot

Simple Telegram bot to generate dynamic BTC support/resistance levels from historical data + predefined JSON.

## Local Setup
1. Clone: `git clone https://github.com/yourusername/btc-levels-bot.git`
2. Install: `npm install`
3. Copy `.env.example` to `.env` and fill values.
4. Run: `npm start`

## Features
- /start: Shows keyboard with "Get Dynamic Levels".
- Button: Fetches & shows predefined vs. dynamic levels (supports/resistances).
- Hybrid: Blends JSON with detected levels (5% tolerance).

## Railway Deploy
1. Push to GitHub.
2. Connect in Railway.app.
3. Set env vars.
4. Access: `/health` for status.

Customize: Toggle hybrid in `getDynamicLevels(usePredefined=true)`.
