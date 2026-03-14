/**
 * SolFlip Database — localStorage-based persistent store
 * Works offline and on any web server (no Node.js required)
 * Shared between index.html and admin.html via localStorage
 */

const DB = {
  // ── Keys ──────────────────────────────────────────────
  KEYS: {
    SETTINGS: 'sf_settings',
    FLIPS:    'sf_flips',
    PLAYERS:  'sf_players',
    CHAT:     'sf_chat',
    WALLETS:  'sf_wallets',
  },

  // ── Helpers ───────────────────────────────────────────
  _get(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
  },
  _set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch { return false; }
  },

  // ── Settings ──────────────────────────────────────────
  defaultSettings() {
    return {
      flipMode:       'random',   // random | weighted | forceHeads | forceTails | pattern
      houseEdge:      4,          // %
      weightedRate:   50,         // player win % for weighted mode
      flipPattern:    'H,T,H,H,T',
      minBet:         0.001,
      maxBet:         0.5,
      maxPayout:      5,
      flipCooldown:   5,          // seconds
      network:        'testnet',  // testnet | mainnet | devnet | custom
      rpcUrl:         'https://api.testnet.solana.com',
      chatEnabled:    true,
      msgCooldown:    3,
      maxMsgLen:      120,
      autoSwitchBelow: 1,
      alertBelow:     2.0,
      adminPass:      'admin123',
      adminUser:      'admin',
      treasuryWallets: [],        // [{label, address, active, flips}]
      patternIndex:   0,
    };
  },
  getSettings() {
    const saved = this._get(this.KEYS.SETTINGS) || {};
    return Object.assign(this.defaultSettings(), saved);
  },
  saveSettings(patch) {
    const cur = this.getSettings();
    this._set(this.KEYS.SETTINGS, Object.assign(cur, patch));
  },
  getMultiplier(edge) {
    const e = (edge !== undefined ? edge : this.getSettings().houseEdge) / 100;
    return parseFloat(((1 - e) * 2).toFixed(4));
  },

  // ── Flips ─────────────────────────────────────────────
  getFlips() { return this._get(this.KEYS.FLIPS) || []; },
  addFlip(flip) {
    // flip: {id, wallet, bet, pick, result, won, pnl, ts, txSig}
    const flips = this.getFlips();
    flips.unshift(flip);
    if (flips.length > 5000) flips.length = 5000; // cap
    this._set(this.KEYS.FLIPS, flips);
    // update player record
    this._updatePlayer(flip);
    return flip;
  },
  clearFlips() { this._set(this.KEYS.FLIPS, []); },

  // ── Players ───────────────────────────────────────────
  getPlayers() { return this._get(this.KEYS.PLAYERS) || []; },
  getPlayer(wallet) {
    return this.getPlayers().find(p => p.wallet === wallet) || null;
  },
  _updatePlayer(flip) {
    const players = this.getPlayers();
    let p = players.find(p => p.wallet === flip.wallet);
    if (!p) {
      p = { wallet: flip.wallet, flips: 0, wins: 0, volume: 0, pnl: 0, banned: false, firstSeen: flip.ts, lastSeen: flip.ts };
      players.push(p);
    }
    p.flips++;
    if (flip.won) p.wins++;
    p.volume = parseFloat((p.volume + flip.bet).toFixed(6));
    p.pnl = parseFloat((p.pnl + flip.pnl).toFixed(6));
    p.lastSeen = flip.ts;
    this._set(this.KEYS.PLAYERS, players);
  },
  banPlayer(wallet, banned = true) {
    const players = this.getPlayers();
    const p = players.find(p => p.wallet === wallet);
    if (p) { p.banned = banned; this._set(this.KEYS.PLAYERS, players); }
  },
  resetPlayers() { this._set(this.KEYS.PLAYERS, []); },

  // ── Chat ──────────────────────────────────────────────
  getChat() { return this._get(this.KEYS.CHAT) || []; },
  addChat(msg) {
    // msg: {id, name, text, ts, system}
    const chat = this.getChat();
    chat.push(msg);
    if (chat.length > 300) chat.splice(0, chat.length - 300);
    this._set(this.KEYS.CHAT, chat);
    return msg;
  },

  // ── Treasury Wallets ──────────────────────────────────
  getTreasuryWallets() {
    return this.getSettings().treasuryWallets || [];
  },
  addTreasuryWallet(wallet) {
    // wallet: {label, address, active, flips, balance}
    const s = this.getSettings();
    const wallets = s.treasuryWallets || [];
    if (!wallets.length) wallet.active = true;
    wallets.push(wallet);
    this.saveSettings({ treasuryWallets: wallets });
  },
  setActiveWallet(address) {
    const s = this.getSettings();
    const wallets = (s.treasuryWallets || []).map(w => ({ ...w, active: w.address === address }));
    this.saveSettings({ treasuryWallets: wallets });
  },
  getActiveWallet() {
    return (this.getTreasuryWallets()).find(w => w.active) || null;
  },

  // ── Stats helpers ─────────────────────────────────────
  getStats() {
    const flips = this.getFlips();
    const players = this.getPlayers();
    const vol = flips.reduce((a, f) => a + f.bet, 0);
    const houseProfit = flips.reduce((a, f) => a + (f.won ? -(f.pnl) : f.bet), 0);
    return {
      totalFlips: flips.length,
      totalVolume: parseFloat(vol.toFixed(6)),
      houseProfit: parseFloat(houseProfit.toFixed(6)),
      totalPlayers: players.length,
      headsCount: flips.filter(f => f.result === 'heads').length,
      tailsCount: flips.filter(f => f.result === 'tails').length,
    };
  },

  // ── Flip outcome engine ───────────────────────────────
  resolveFlip(txSig) {
    const s = this.getSettings();
    const mode = s.flipMode;
    let result;

    if (mode === 'forceHeads') {
      result = 'heads';
    } else if (mode === 'forceTails') {
      result = 'tails';
    } else if (mode === 'weighted') {
      result = Math.random() < (s.weightedRate / 100) ? 'heads' : 'tails';
    } else if (mode === 'pattern') {
      const pattern = s.flipPattern.split(',').map(x => x.trim().toUpperCase());
      const idx = (s.patternIndex || 0) % pattern.length;
      result = pattern[idx] === 'H' ? 'heads' : 'tails';
      this.saveSettings({ patternIndex: idx + 1 });
    } else {
      // RANDOM — provably fair using txSig hash approximation
      if (txSig) {
        // Use last char of txSig for determinism
        const code = txSig.charCodeAt(txSig.length - 1);
        result = code % 2 === 0 ? 'heads' : 'tails';
      } else {
        result = Math.random() < 0.5 ? 'heads' : 'tails';
      }
    }
    return result;
  },

  // ── Storage events (cross-tab sync) ──────────────────
  onChange(callback) {
    window.addEventListener('storage', (e) => {
      if (Object.values(this.KEYS).includes(e.key)) {
        callback(e.key, e.newValue);
      }
    });
  },
};

// Initialize default settings if none exist
if (!localStorage.getItem(DB.KEYS.SETTINGS)) {
  DB.saveSettings(DB.defaultSettings());
}

// Random username generator
const ADJECTIVES = ['Swift','Bold','Dark','Neon','Crypto','Sol','Lucky','Rekt','Moon','Degen','Ghost','Alpha','Sigma','Delta','Turbo'];
const NOUNS      = ['Trader','Flipper','Whale','Chad','Ape','Shark','Wolf','Bull','Bear','Degen','Rider','Punk','Hawk','Fox','King'];
function randomUsername() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 999);
  return a + n + num;
}