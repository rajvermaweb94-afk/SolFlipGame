/**
 * SolFlip — Backend Server with Autopayout
 * 
 * SETUP (one time only):
 *   npm install @solana/web3.js bs58
 * 
 * THEN RUN:
 *   node server.js
 *
 * Game:   http://localhost:8080
 * Admin:  http://localhost:8080/admin.html
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Load Solana SDK ──────────────────────────────────────
let solanaWeb3, bs58;
try {
  solanaWeb3 = require('@solana/web3.js');
  bs58       = require('bs58');
} catch(e) {
  console.error('\n  ❌  Missing packages. Run this first:\n');
  console.error('     npm install @solana/web3.js bs58\n');
  process.exit(1);
}

const {
  Connection, PublicKey, Keypair,
  Transaction, SystemProgram, LAMPORTS_PER_SOL
} = solanaWeb3;

const PORT    = 8080;
// Use Railway volume path if set, else fall back to local file
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'solflip_db.json');
console.log('[DB] Database path:', DB_FILE);
console.log('[DB] Using database file:', DB_FILE);

// ── Database (JSON file) ─────────────────────────────────
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return getDefaultDB();
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Merge defaults so new keys are added but SAVED values always win
    const def = getDefaultDB();
    saved.settings = Object.assign({}, def.settings, saved.settings);
    // Auto-derive treasuryAddress from private key if missing or empty
    if (saved.settings.treasuryPrivKey && !saved.settings.treasuryAddress) {
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(saved.settings.treasuryPrivKey));
        saved.settings.treasuryAddress = kp.publicKey.toString();
        // Write back immediately so it persists
        fs.writeFileSync(DB_FILE, JSON.stringify(saved, null, 2));
      } catch(e) { /* invalid key format */ }
    }
    return saved;
  } catch(e) { return getDefaultDB(); }
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function getDefaultDB() {
  return {
    settings: {
      flipMode:        'random',
      houseEdge:       4,
      weightedRate:    50,
      flipPattern:     'H,T,H,H,T',
      patternIndex:    0,
      minBet:          0.001,
      maxBet:          0.5,
      maxPayout:       5,
      flipCooldown:    5,
      network:         'mainnet',
      rpcUrl:          '',
      chatEnabled:     true,
      msgCooldown:     3,
      maxMsgLen:       120,
      adminPass:       'admin123',
      adminUser:       'admin',
      autoSwitchBelow: 1,
      alertBelow:      2,
      treasuryPrivKey: '',   // base58 private key — set via admin
      treasuryAddress: '',
    },
    flips:   [],
    players: {},
    chat:    [],
  };
}

// ── Solana helpers ───────────────────────────────────────
function getConnection(db) {
  const s    = db.settings;
  const rpcs = {
    testnet: 'https://api.testnet.solana.com',
    mainnet: 'https://api.mainnet-beta.solana.com',
    devnet:  'https://api.devnet.solana.com',
  };
  // Priority: env HELIUS_RPC > saved rpcUrl > network preset
  const url = process.env.HELIUS_RPC || s.rpcUrl || rpcs[s.network] || rpcs.mainnet;
  return new Connection(url, 'confirmed');
}

function getTreasuryKeypair(db) {
  const key = db.settings.treasuryPrivKey;
  if (!key) throw new Error('Treasury private key not set in admin settings');
  try {
    const decoded = bs58.decode(key);
    return Keypair.fromSecretKey(decoded);
  } catch(e) {
    throw new Error('Invalid treasury private key format');
  }
}

function getMultiplier(edge) {
  return parseFloat(((1 - edge / 100) * 2).toFixed(4));
}

// Resolve flip outcome based on mode
function resolveFlip(db, txSig) {
  const s = db.settings;
  let result;
  if (s.flipMode === 'forceHeads') {
    result = 'heads';
  } else if (s.flipMode === 'forceTails') {
    result = 'tails';
  } else if (s.flipMode === 'weighted') {
    result = Math.random() < (s.weightedRate / 100) ? 'heads' : 'tails';
  } else if (s.flipMode === 'pattern') {
    const pat = s.flipPattern.split(',').map(x => x.trim().toUpperCase());
    const idx = (s.patternIndex || 0) % pat.length;
    result = pat[idx] === 'H' ? 'heads' : 'tails';
    db.settings.patternIndex = idx + 1;
  } else {
    // RANDOM — use txSig for provable fairness
    if (txSig && txSig.length > 4) {
      const code = txSig.charCodeAt(txSig.length - 1) + txSig.charCodeAt(txSig.length - 2);
      result = code % 2 === 0 ? 'heads' : 'tails';
    } else {
      result = Math.random() < 0.5 ? 'heads' : 'tails';
    }
  }
  return result;
}

// Update player stats
function updatePlayer(db, wallet, flip) {
  if (!db.players[wallet]) {
    db.players[wallet] = { wallet, flips:0, wins:0, volume:0, pnl:0, banned:false, firstSeen: flip.ts, lastSeen: flip.ts };
  }
  const p = db.players[wallet];
  p.flips++;
  if (flip.won) p.wins++;
  p.volume  = parseFloat((p.volume + flip.bet).toFixed(6));
  p.pnl     = parseFloat((p.pnl + flip.pnl).toFixed(6));
  p.lastSeen = flip.ts;
}

// ── MIME types ───────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.ico':'image/x-icon', '.svg':'image/svg+xml',
  '.woff2':'font/woff2', '.woff':'font/woff',
};

// ── JSON response helpers ────────────────────────────────
function jsonOk(res, data) {
  res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify({ ok: true, ...data }));
}
function jsonErr(res, msg, code = 400) {
  res.writeHead(code, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify({ ok: false, error: msg }));
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── HTTP Server ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST,GET,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,x-admin-token' });
    res.end(); return;
  }

  // ── API ROUTES ──────────────────────────────────────
  if (urlPath.startsWith('/api/')) {

    // GET /api/settings — public settings (no private key)
    if (req.method === 'GET' && urlPath === '/api/settings') {
      const db = readDB();
      const s  = { ...db.settings };
      delete s.treasuryPrivKey; // never expose private key
      delete s.adminPass;
      return jsonOk(res, { settings: s });
    }

    // GET /api/fix-treasury — force re-derive treasury address (use once if treasury shows not set)
    if (req.method === 'GET' && urlPath === '/api/fix-treasury') {
      const db = readDB();
      if (!db.settings.treasuryPrivKey) {
        return jsonOk(res, { ok: false, message: 'No private key saved. Go to admin Settings and save your private key first.' });
      }
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(db.settings.treasuryPrivKey));
        db.settings.treasuryAddress = kp.publicKey.toString();
        writeDB(db);
        return jsonOk(res, { ok: true, message: 'Treasury address fixed!', address: db.settings.treasuryAddress });
      } catch(e) {
        return jsonOk(res, { ok: false, message: 'Invalid private key: ' + e.message });
      }
    }

    // GET /api/balance?wallet=... — proxy balance fetch (avoids browser CORS)
    if (req.method === 'GET' && urlPath === '/api/balance') {
      const walletAddr = req.url.split('wallet=')[1];
      if (!walletAddr) return jsonErr(res, 'Missing wallet param');
      try {
        const conn = getConnection(readDB());
        const bal  = await conn.getBalance(new PublicKey(walletAddr.split('&')[0]));
        return jsonOk(res, { balance: bal / LAMPORTS_PER_SOL });
      } catch(e) { return jsonErr(res, e.message); }
    }

    // POST /api/flip — resolve flip + send payout if won
    if (req.method === 'POST' && urlPath === '/api/flip') {
      let body;
      try { body = await parseBody(req); } catch(e) { return jsonErr(res, 'Invalid JSON'); }

      const { wallet, bet, pick, txSig } = body;
      if (!wallet || !bet || !pick || !txSig) return jsonErr(res, 'Missing fields: wallet, bet, pick, txSig');

      const db = readDB();
      const s  = db.settings;

      // Check ban
      if (db.players[wallet] && db.players[wallet].banned) return jsonErr(res, 'Wallet is banned');

      // Validate bet
      if (bet < s.minBet) return jsonErr(res, 'Bet below minimum');
      if (bet > s.maxBet) return jsonErr(res, 'Bet above maximum');

      // Resolve outcome
      const result  = resolveFlip(db, txSig);
      const won     = result === pick;
      const mult    = getMultiplier(s.houseEdge);
      const payout  = parseFloat((bet * mult).toFixed(6));
      const pnlAmt  = won ? parseFloat((payout - bet).toFixed(6)) : parseFloat((-bet).toFixed(6));

      let payoutSig = null;

      // Send payout if player won
      if (won) {
        try {
          const conn     = getConnection(db);
          const treasury = getTreasuryKeypair(db);
          const lamports = Math.round(payout * LAMPORTS_PER_SOL);

          const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
          const tx = new Transaction({ recentBlockhash: blockhash, feePayer: treasury.publicKey })
            .add(SystemProgram.transfer({
              fromPubkey: treasury.publicKey,
              toPubkey:   new PublicKey(wallet),
              lamports,
            }));

          tx.sign(treasury);
          payoutSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          await conn.confirmTransaction({ signature: payoutSig, blockhash, lastValidBlockHeight }, 'confirmed');

          console.log(`  ✅ Payout sent: ${payout} SOL → ${wallet.slice(0,10)}… | tx: ${payoutSig}`);
        } catch(e) {
          console.error('  ❌ Payout failed:', e.message);
          // Still record the flip but flag payout failure
          payoutSig = 'PAYOUT_FAILED: ' + e.message;
        }
      }

      // Record flip
      const flip = {
        id:        txSig,
        wallet,
        bet:       parseFloat(bet),
        pick,
        result,
        won,
        pnl:       pnlAmt,
        mult,
        payout:    won ? payout : 0,
        payoutSig,
        ts:        new Date().toISOString(),
        txSig,
      };
      db.flips.unshift(flip);
      if (db.flips.length > 5000) db.flips.length = 5000;
      updatePlayer(db, wallet, flip);
      writeDB(db);

      console.log(`  🎲 Flip: ${wallet.slice(0,10)}… bet ${bet} SOL on ${pick.toUpperCase()} → ${result.toUpperCase()} | ${won ? '✅ WON' : '❌ LOST'}`);
      return jsonOk(res, { result, won, payout: won ? payout : 0, pnl: pnlAmt, mult, payoutSig });
    }

    // POST /api/chat — add chat message
    if (req.method === 'POST' && urlPath === '/api/chat') {
      let body;
      try { body = await parseBody(req); } catch(e) { return jsonErr(res, 'Invalid JSON'); }
      const db = readDB();
      if (!db.settings.chatEnabled) return jsonErr(res, 'Chat disabled');
      const msg = { id: Date.now(), name: String(body.name||'Anon').slice(0,20), text: String(body.text||'').slice(0, db.settings.maxMsgLen||120), ts: new Date().toISOString(), system: false, gameEvent: !!body.gameEvent };
      db.chat.push(msg);
      if (db.chat.length > 300) db.chat.splice(0, db.chat.length - 300);
      writeDB(db);
      return jsonOk(res, { msg });
    }

    // GET /api/chat — get recent chat
    if (req.method === 'GET' && urlPath === '/api/chat') {
      const db = readDB();
      // Count unique wallets active in last 5 minutes as online count
      const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
      const onlineCount = Object.values(db.players || {}).filter(p => p.lastSeen && p.lastSeen > fiveMinsAgo).length;
      return jsonOk(res, { messages: db.chat.slice(-60), onlineCount });
    }

    // GET /api/stats — public stats
    if (req.method === 'GET' && urlPath === '/api/stats') {
      const db = readDB();
      const flips   = db.flips;
      const players = Object.values(db.players);
      return jsonOk(res, {
        totalFlips:   flips.length,
        headsCount:   flips.filter(f => f.result === 'heads').length,
        tailsCount:   flips.filter(f => f.result === 'tails').length,
        totalPlayers: players.length,
        recentFlips:  flips.slice(0, 30),
      });
    }

    // ── ADMIN API (password required) ──────────────────

    // POST /api/admin/login
    if (req.method === 'POST' && urlPath === '/api/admin/login') {
      let body;
      try { body = await parseBody(req); } catch(e) { return jsonErr(res, 'Invalid JSON'); }
      const db = readDB();
      const validUser = db.settings.adminUser || 'admin';
      const validPass = db.settings.adminPass || 'admin123';
      // Accept provided credentials OR hardcoded defaults as fallback
      const isValid = (body.user === validUser && body.pass === validPass)
                   || (body.user === 'admin'    && body.pass === 'admin123');
      if (isValid) {
        const token = 'sf_' + Buffer.from(validPass).toString('base64');
        return jsonOk(res, { token });
      }
      return jsonErr(res, 'Invalid credentials', 401);
    }

    // Admin auth middleware
    const adminRoutes = ['/api/admin/settings', '/api/admin/players', '/api/admin/flips', '/api/admin/treasury'];
    if (adminRoutes.some(r => urlPath.startsWith(r))) {
      const db  = readDB();
      const auth = req.headers['x-admin-token'] || '';
      const expected = 'sf_' + Buffer.from(db.settings.adminPass||'admin123').toString('base64');
      if (auth !== expected) return jsonErr(res, 'Unauthorized', 401);

      // GET /api/admin/settings
      if (req.method === 'GET' && urlPath === '/api/admin/settings') {
        return jsonOk(res, { settings: db.settings });
      }

      // POST /api/admin/settings
      if (req.method === 'POST' && urlPath === '/api/admin/settings') {
        let body;
        try { body = await parseBody(req); } catch(e) { return jsonErr(res, 'Invalid JSON'); }
        Object.assign(db.settings, body);
        // Update treasury address from private key if key provided
        if (body.treasuryPrivKey) {
          try {
            const kp = Keypair.fromSecretKey(bs58.decode(body.treasuryPrivKey));
            db.settings.treasuryAddress = kp.publicKey.toString();
            console.log('[TREASURY] Address set:', db.settings.treasuryAddress);
          } catch(e) { return jsonErr(res, 'Invalid private key — check format is base58'); }
        }
        // Re-derive from stored key if address still missing
        if (db.settings.treasuryPrivKey && !db.settings.treasuryAddress) {
          try {
            const kp = Keypair.fromSecretKey(bs58.decode(db.settings.treasuryPrivKey));
            db.settings.treasuryAddress = kp.publicKey.toString();
          } catch(e) {}
        }
        writeDB(db);
        console.log('[SETTINGS] Saved. Network:', db.settings.network, '| Treasury:', db.settings.treasuryAddress || 'NOT SET');
        return jsonOk(res, { settings: db.settings });
      }

      // GET /api/admin/players
      if (req.method === 'GET' && urlPath === '/api/admin/players') {
        return jsonOk(res, { players: Object.values(db.players) });
      }

      // POST /api/admin/players/ban
      if (req.method === 'POST' && urlPath === '/api/admin/players/ban') {
        let body;
        try { body = await parseBody(req); } catch(e) { return jsonErr(res, 'Invalid JSON'); }
        if (db.players[body.wallet]) { db.players[body.wallet].banned = !!body.banned; writeDB(db); }
        return jsonOk(res, {});
      }

      // GET /api/admin/flips
      if (req.method === 'GET' && urlPath === '/api/admin/flips') {
        return jsonOk(res, { flips: db.flips.slice(0, 100), stats: {
          totalFlips:  db.flips.length,
          totalVolume: db.flips.reduce((a,f)=>a+f.bet,0).toFixed(4),
          houseProfit: db.flips.reduce((a,f)=>a+(f.won?-(f.payout-f.bet):f.bet),0).toFixed(4),
        }});
      }

      // POST /api/admin/flips/clear
      if (req.method === 'POST' && urlPath === '/api/admin/flips/clear') {
        db.flips = []; writeDB(db);
        return jsonOk(res, {});
      }

      // POST /api/admin/players/reset
      if (req.method === 'POST' && urlPath === '/api/admin/players/reset') {
        db.players = {}; writeDB(db);
        return jsonOk(res, {});
      }

      // GET /api/admin/treasury/balance
      if (req.method === 'GET' && urlPath === '/api/admin/treasury/balance') {
        try {
          const conn = getConnection(db);
          const bal  = await conn.getBalance(new PublicKey(db.settings.treasuryAddress));
          return jsonOk(res, { balance: bal / LAMPORTS_PER_SOL, address: db.settings.treasuryAddress });
        } catch(e) { return jsonErr(res, e.message); }
      }
    }

    return jsonErr(res, 'Unknown API endpoint', 404);
  }

  // ── STATIC FILE SERVING ──────────────────────────────
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const ext    = path.extname(filePath).toLowerCase();
  const mime   = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); }
      else { res.writeHead(500); res.end('Server error'); }
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  // ── Auto-fix: derive treasuryAddress from private key if missing ──
  const db = readDB();
  if (db.settings.treasuryPrivKey && !db.settings.treasuryAddress) {
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(db.settings.treasuryPrivKey));
      db.settings.treasuryAddress = kp.publicKey.toString();
      writeDB(db);
      console.log('[TREASURY] Auto-derived address:', db.settings.treasuryAddress);
    } catch(e) {
      console.log('[TREASURY] Warning: could not derive address from private key:', e.message);
    }
  }
  // ── Also auto-derive on every readDB in case DB was reset ──
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║        SOLFLIP SERVER RUNNING            ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Game:    http://localhost:' + PORT + '          ║');
  console.log('  ║  Admin:   http://localhost:' + PORT + '/admin.html ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Network: ' + (db.settings.network||'mainnet').padEnd(30) + '║');
  if (db.settings.treasuryAddress) {
  console.log('  ║  Treasury: ' + db.settings.treasuryAddress.slice(0,28) + '… ║');
  } else {
  console.log('  ║  Treasury: ⚠️  NOT SET (set in admin)      ║');
  }
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Press Ctrl+C to stop                    ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
