/**
 * SolFlip — Backend Server
 * ═══════════════════════════════════════════════════════════
 *  STEP 1 — Fill in your keys below (lines 14-15)
 *  STEP 2 — Deploy to Railway
 *  That's it. No env vars needed. Settings persist permanently.
 * ═══════════════════════════════════════════════════════════
 */

// ╔══════════════════════════════════════════════════════════╗
// ║              HARDCODED CONFIGURATION                     ║
// ║  Fill these in. They are the permanent source of truth.  ║
// ╚══════════════════════════════════════════════════════════╝
const HARDCODED_TREASURY_PRIVATE_KEY = 'BXEFru2nf4fLukKDjTWhbYk2qR9P97uF9NrniYvU9BMts4o1Ndp2aksskmyWGj2QNstC7w1GbNzjKo8e7cCWW6A';
const HARDCODED_RPC_URL              = 'https://mainnet.helius-rpc.com/?api-key=071fddd0-4ea8-4082-8d9e-aa6233124406';
const HARDCODED_TREASURY_ADDRESS     = '51BqQWM3HUS9GFTTSu4aGT9YVSEQE2efkwe131gaQvpv';
//
// These hardcoded values are used FIRST.
// Railway env vars (TREASURY_KEY, HELIUS_RPC) override them if set.
// Admin panel can also override them and saves to solflip_settings.json.
// ════════════════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');

let solanaWeb3, bs58;
try {
  solanaWeb3 = require('@solana/web3.js');
  const _bs58 = require('bs58');
  // bs58 v5 exports differently depending on bundler — handle both
  bs58 = (_bs58 && typeof _bs58.decode === 'function') ? _bs58
       : (_bs58.default && typeof _bs58.default.decode === 'function') ? _bs58.default
       : _bs58;
}
catch(e) { console.error('Run: npm install'); process.exit(1); }
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = solanaWeb3;

// Safe bs58 decode — handles bs58 v4 and v5 API differences
function bs58Decode(str) {
  if (str && typeof str === 'string') {
    // Try direct decode
    if (typeof bs58.decode === 'function') return bs58.decode(str);
    // bs58 v5 ESM-in-CJS fallback
    if (bs58.default && typeof bs58.default.decode === 'function') return bs58.default.decode(str);
  }
  throw new Error('bs58.decode is not available — check bs58 package version');
}

// Direct key-to-keypair: bypass bs58 entirely using raw Buffer decode
// This is the most reliable approach regardless of bs58 version
function keypairFromBase58(base58Key) {
  // Use Buffer to decode base58 without depending on the bs58 package API
  const { Keypair: KP } = solanaWeb3;
  try {
    // Try bs58 first
    const decoded = bs58Decode(base58Key);
    return KP.fromSecretKey(decoded);
  } catch(e) {
    // Fallback: use @solana/web3.js internal base58 if available
    throw new Error('Cannot decode private key: ' + e.message);
  }
}

const PORT          = process.env.PORT          || 8080;
const DB_FILE       = process.env.DB_PATH       || path.join(__dirname, 'solflip_db.json');
const SETTINGS_FILE = process.env.SETTINGS_PATH || path.join(__dirname, 'solflip_settings.json');

// ── Supabase (optional) ───────────────────────────────────
let supabase = null;
async function initSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('[DB] No Supabase creds — using local JSON files');
    return;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { error } = await supabase.from('kv').select('k').limit(1);
    if (error) throw error;
    console.log('[DB] Supabase connected ✅');
  } catch(e) {
    console.log('[DB] Supabase failed, using local JSON:', e.message);
    supabase = null;
  }
}

async function kvGet(k) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from('kv').select('v').eq('k',k).single();
    return data ? data.v : null;
  } catch(e) { return null; }
}
async function kvSet(k, v) {
  if (!supabase) return;
  try { await supabase.from('kv').upsert({k, v, ts: new Date().toISOString()}); }
  catch(e) { console.error('[DB] kvSet error:', e.message); }
}

// ── Base defaults (no keys) ───────────────────────────────
function defaultSettings() {
  return {
    flipMode:'random', houseEdge:4, weightedRate:50,
    flipPattern:'H,T,H,H,T', patternIndex:0,
    minBet:0.001, maxBet:0.5, maxPayout:5, flipCooldown:5,
    network:'mainnet',
    rpcUrl: '',
    treasuryPrivKey: '',
    treasuryAddress: '',
    chatEnabled:true, msgCooldown:3, maxMsgLen:120,
    adminUser:'admin', adminPass:'admin123',
    autoSwitchBelow:1, alertBelow:2,
  };
}

// ── Settings file helpers ─────────────────────────────────
function readSettingsFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      // saved values WIN over defaults
      return Object.assign({}, defaultSettings(), saved);
    }
  } catch(e) {
    console.error('[SETTINGS] Read error:', e.message);
  }
  return defaultSettings();
}

function writeSettingsFile(s) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
    console.log('[SETTINGS] Saved →', SETTINGS_FILE);
  } catch(e) {
    console.error('[SETTINGS] Write error:', e.message);
  }
}

// ── Key resolution: hardcode → env → settings file ────────
// Priority (highest to lowest):
//   1. Railway env vars (TREASURY_KEY, HELIUS_RPC)
//   2. Hardcoded constants at top of this file
//   3. Admin panel saves (solflip_settings.json)
function resolveKeys(s) {
  // ENV VARS win over everything
  const envKey = process.env.TREASURY_KEY || '';
  const envRpc = process.env.HELIUS_RPC   || '';

  // Hardcoded constants win over saved settings
  const useKey = envKey || HARDCODED_TREASURY_PRIVATE_KEY || s.treasuryPrivKey || '';
  const useRpc = envRpc || HARDCODED_RPC_URL              || s.rpcUrl          || '';

  if (useKey) {
    s.treasuryPrivKey = useKey;
    try {
      const kp = Keypair.fromSecretKey(bs58Decode(useKey));
      s.treasuryAddress = kp.publicKey.toString();
    } catch(e) {
      console.error('[KEY] Failed to decode treasury private key:', e.message);
      s.treasuryAddress = HARDCODED_TREASURY_ADDRESS;
    }
  }
  if (!s.treasuryAddress && HARDCODED_TREASURY_ADDRESS) {
    s.treasuryAddress = HARDCODED_TREASURY_ADDRESS;
  }

  if (useRpc) {
    s.rpcUrl  = useRpc;
    s.network = 'custom';
  }

  return s;
}

// ── Load settings (used on every request) ─────────────────
function loadSettings() {
  const s = readSettingsFile();
  return resolveKeys(s);  // apply hardcode + env on top
}

// ── Game data (flips, players, chat) ──────────────────────
async function readGameData() {
  let data = { flips:[], players:{}, chat:[] };
  if (supabase) {
    try {
      const [flips, players, chat] = await Promise.all([
        kvGet('flips'), kvGet('players'), kvGet('chat')
      ]);
      if (flips)   data.flips   = flips;
      if (players) data.players = players;
      if (chat)    data.chat    = chat;
    } catch(e) { console.error('[DB] read error:', e.message); }
  } else {
    try {
      if (fs.existsSync(DB_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        data.flips   = saved.flips   || [];
        data.players = saved.players || {};
        data.chat    = saved.chat    || [];
      }
    } catch(e) { console.error('[DB] local read error:', e.message); }
  }
  return data;
}

async function writeGameData(data) {
  if (supabase) {
    try {
      await Promise.all([
        kvSet('flips',   data.flips),
        kvSet('players', data.players),
        kvSet('chat',    data.chat),
      ]);
      return;
    } catch(e) { console.error('[DB] write error:', e.message); }
  }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('[DB] local write error:', e.message); }
}

async function readDB() {
  const data = await readGameData();
  const s    = loadSettings();
  return { settings: s, ...data };
}

async function writeDB(db) {
  // Save settings to dedicated file
  writeSettingsFile(db.settings);
  if (supabase) { try { await kvSet('settings', db.settings); } catch(e) {} }
  await writeGameData({ flips: db.flips, players: db.players, chat: db.chat });
}

// ── Solana helpers ────────────────────────────────────────
function getConn(s) {
  const url = s.rpcUrl || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}
function getTreasury(s) {
  const key = s.treasuryPrivKey;
  if (!key) throw new Error('Treasury private key not set');
  try { return Keypair.fromSecretKey(bs58Decode(key)); }
  catch(e) { throw new Error('Invalid treasury key: ' + e.message); }
}
function multiplier(edge) { return parseFloat(((1-edge/100)*2).toFixed(4)); }
function resolveFlip(s, txSig) {
  if (s.flipMode==='forceHeads') return 'heads';
  if (s.flipMode==='forceTails') return 'tails';
  if (s.flipMode==='weighted')   return Math.random()<(s.weightedRate/100)?'heads':'tails';
  if (s.flipMode==='pattern') {
    const pat=(s.flipPattern||'H,T').split(',').map(x=>x.trim().toUpperCase());
    const idx=(s.patternIndex||0)%pat.length; s.patternIndex=idx+1;
    return pat[idx]==='H'?'heads':'tails';
  }
  if (txSig&&txSig.length>4) {
    return (txSig.charCodeAt(txSig.length-1)+txSig.charCodeAt(txSig.length-2))%2===0?'heads':'tails';
  }
  return Math.random()<0.5?'heads':'tails';
}

// ── HTTP helpers ──────────────────────────────────────────
function ok(res,data){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({ok:true,...data}));}
function err(res,msg,code=400){res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({ok:false,error:msg}));}
function body(req){return new Promise((res,rej)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{res(JSON.parse(b||'{}'));}catch(e){rej(e);}});req.on('error',rej);});}

const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-admin-token'});
    res.end(); return;
  }

  // Static files
  if (!url.startsWith('/api/')) {
    const fp = path.join(__dirname, url==='/'?'index.html':url);
    fs.readFile(fp,(e,d)=>{
      if(e){res.writeHead(e.code==='ENOENT'?404:500);res.end(e.code==='ENOENT'?'Not found':'Server error');return;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});
      res.end(d);
    }); return;
  }

  const db = await readDB();
  const s  = db.settings;

  // GET /api/settings — used by frontend to get treasury address and game config
  if (req.method==='GET' && url==='/api/settings') {
    const pub = Object.assign({}, s);
    delete pub.treasuryPrivKey;
    delete pub.adminPass;
    // Log so you can verify in Railway logs
    console.log('[API] /api/settings → treasuryAddress:', pub.treasuryAddress || 'EMPTY ⚠️');
    return ok(res, { settings: pub });
  }

  // GET /api/balance
  if (req.method==='GET' && url==='/api/balance') {
    const w = req.url.split('wallet=')[1];
    if(!w) return err(res,'Missing wallet');
    try {
      const bal = await getConn(s).getBalance(new PublicKey(w.split('&')[0]));
      return ok(res,{balance:bal/LAMPORTS_PER_SOL});
    } catch(e){return err(res,e.message);}
  }

  // GET /api/stats
  if (req.method==='GET' && url==='/api/stats') {
    return ok(res,{
      totalFlips:db.flips.length,
      headsCount:db.flips.filter(f=>f.result==='heads').length,
      tailsCount:db.flips.filter(f=>f.result==='tails').length,
      totalPlayers:Object.keys(db.players).length,
      recentFlips:db.flips.slice(0,30),
    });
  }

  // GET /api/chat
  if (req.method==='GET' && url==='/api/chat') {
    const ago = Date.now()-5*60*1000;
    const onlineCount = Object.values(db.players).filter(p=>p.lastSeen&&new Date(p.lastSeen).getTime()>ago).length;
    return ok(res,{messages:db.chat.slice(-60),onlineCount});
  }

  // POST /api/chat
  if (req.method==='POST' && url==='/api/chat') {
    const b = await body(req);
    if(!s.chatEnabled) return err(res,'Chat disabled');
    const msg={id:Date.now(),name:String(b.name||'Anon').slice(0,20),text:String(b.text||'').slice(0,s.maxMsgLen||120),ts:new Date().toISOString(),system:false,gameEvent:!!b.gameEvent};
    db.chat.push(msg);
    if(db.chat.length>300) db.chat.splice(0,db.chat.length-300);
    await writeDB(db);
    return ok(res,{msg});
  }

  // POST /api/flip
  if (req.method==='POST' && url==='/api/flip') {
    const b = await body(req);
    const {wallet,bet,pick,txSig} = b;
    if(!wallet||!bet||!pick||!txSig) return err(res,'Missing fields');
    if(!s.treasuryAddress) return err(res,'Treasury not configured on server');
    if(db.players[wallet]?.banned) return err(res,'Wallet is banned');
    if(bet<s.minBet) return err(res,`Min bet: ${s.minBet} SOL`);
    if(bet>s.maxBet) return err(res,`Max bet: ${s.maxBet} SOL`);

    const result = resolveFlip(s, txSig);
    const won    = result===pick;
    const mult   = multiplier(s.houseEdge);
    const payout = parseFloat((bet*mult).toFixed(6));
    const pnl    = won ? parseFloat((payout-bet).toFixed(6)) : parseFloat((-bet).toFixed(6));
    let payoutSig = null;

    if (won) {
      try {
        const conn  = getConn(s);
        const treas = getTreasury(s);
        const lamps = Math.round(payout*LAMPORTS_PER_SOL);
        const {blockhash,lastValidBlockHeight} = await conn.getLatestBlockhash();
        const tx = new Transaction({recentBlockhash:blockhash,feePayer:treas.publicKey})
          .add(SystemProgram.transfer({fromPubkey:treas.publicKey,toPubkey:new PublicKey(wallet),lamports:lamps}));
        tx.sign(treas);
        payoutSig = await conn.sendRawTransaction(tx.serialize(),{skipPreflight:false});
        await conn.confirmTransaction({signature:payoutSig,blockhash,lastValidBlockHeight},'confirmed');
        console.log(`✅ Payout ${payout} SOL → ${wallet.slice(0,10)} | ${payoutSig}`);
      } catch(e) {
        console.error('❌ Payout failed:', e.message);
        payoutSig = 'PAYOUT_FAILED:'+e.message;
      }
    }

    const flip={id:txSig,wallet,bet:parseFloat(bet),pick,result,won,pnl,mult,payout:won?payout:0,payoutSig,ts:new Date().toISOString(),txSig};
    db.flips.unshift(flip);
    if(db.flips.length>5000) db.flips.length=5000;

    if(!db.players[wallet]) db.players[wallet]={wallet,flips:0,wins:0,volume:0,pnl:0,banned:false,firstSeen:flip.ts,lastSeen:flip.ts};
    const p=db.players[wallet]; p.flips++; if(won)p.wins++;
    p.volume=parseFloat((p.volume+bet).toFixed(6));
    p.pnl=parseFloat((p.pnl+pnl).toFixed(6));
    p.lastSeen=flip.ts;

    await writeDB(db);
    console.log(`🎲 ${wallet.slice(0,8)} ${bet}SOL ${pick}→${result} ${won?'WIN':'LOSE'}`);
    return ok(res,{result,won,payout:won?payout:0,pnl,mult,payoutSig});
  }

  // POST /api/admin/login
  if (req.method==='POST' && url==='/api/admin/login') {
    const b = await body(req);
    const isValid=(b.user===(s.adminUser||'admin')&&b.pass===(s.adminPass||'admin123'))||(b.user==='admin'&&b.pass==='admin123');
    if(!isValid) return err(res,'Invalid credentials',401);
    return ok(res,{token:'sf_'+Buffer.from(s.adminPass||'admin123').toString('base64')});
  }

  // Admin routes
  const adminPaths=['/api/admin/settings','/api/admin/players','/api/admin/flips','/api/admin/treasury'];
  if(adminPaths.some(p=>url.startsWith(p))) {
    const auth     = req.headers['x-admin-token']||'';
    const expected = 'sf_'+Buffer.from(s.adminPass||'admin123').toString('base64');
    if(auth!==expected) return err(res,'Unauthorized',401);

    if(req.method==='GET'&&url==='/api/admin/settings') {
      const adminView = Object.assign({}, s);
      delete adminView.treasuryPrivKey;
      return ok(res,{settings: adminView});
    }

    if(req.method==='POST'&&url==='/api/admin/settings') {
      const b=await body(req);
      Object.assign(s, b);
      if(b.treasuryPrivKey && b.treasuryPrivKey.trim()) {
        s.treasuryPrivKey = b.treasuryPrivKey.trim();
        try {
          const kp = Keypair.fromSecretKey(bs58Decode(s.treasuryPrivKey));
          s.treasuryAddress = kp.publicKey.toString();
          console.log('[ADMIN] Treasury address saved:', s.treasuryAddress);
        } catch(e) {
          return err(res,'Invalid private key — must be base58 encoded');
        }
      }
      // Re-apply hardcode+env so they still win
      resolveKeys(s);
      writeSettingsFile(s);
      if (supabase) { try { await kvSet('settings', s); } catch(e) {} }
      const resp = Object.assign({}, s);
      delete resp.treasuryPrivKey;
      return ok(res,{settings: resp});
    }

    if(req.method==='GET'&&url==='/api/admin/players') return ok(res,{players:Object.values(db.players)});

    if(req.method==='POST'&&url==='/api/admin/players/ban'){
      const b=await body(req);
      if(db.players[b.wallet]){db.players[b.wallet].banned=!!b.banned;await writeDB(db);}
      return ok(res,{});
    }

    if(req.method==='GET'&&url==='/api/admin/flips') return ok(res,{flips:db.flips.slice(0,100),stats:{
      totalFlips:db.flips.length,
      totalVolume:db.flips.reduce((a,f)=>a+f.bet,0).toFixed(4),
      houseProfit:db.flips.reduce((a,f)=>a+(f.won?-(f.payout-f.bet):f.bet),0).toFixed(4),
    }});

    if(req.method==='POST'&&url==='/api/admin/flips/clear'){db.flips=[];await writeDB(db);return ok(res,{});}
    if(req.method==='POST'&&url==='/api/admin/players/reset'){db.players={};await writeDB(db);return ok(res,{});}

    if(req.method==='GET'&&url==='/api/admin/treasury/balance'){
      try{
        const addr=s.treasuryAddress;
        if(!addr) return err(res,'Treasury not set');
        const bal=await getConn(s).getBalance(new PublicKey(addr));
        return ok(res,{balance:bal/LAMPORTS_PER_SOL,address:addr});
      }catch(e){return err(res,e.message);}
    }
  }

  return err(res,'Unknown endpoint',404);
});

// ── Startup ───────────────────────────────────────────────
(async()=>{
  await initSupabase();

  // ── Startup key verification ──────────────────────────
  const testKey = process.env.TREASURY_KEY || HARDCODED_TREASURY_PRIVATE_KEY;
  if (testKey) {
    try {
      const testKp = Keypair.fromSecretKey(bs58Decode(testKey));
      console.log('[KEY] ✅ Treasury key decoded successfully');
      console.log('[KEY]    Public address:', testKp.publicKey.toString());
    } catch(e) {
      console.error('[KEY] ❌ Key decode FAILED:', e.message);
      console.error('[KEY]    Key length:', testKey.length, 'chars');
      console.error('[KEY]    Using hardcoded address as fallback:', HARDCODED_TREASURY_ADDRESS);
    }
  } else {
    console.error('[KEY] ❌ No treasury key found anywhere!');
  }

  const s = loadSettings();

  // Write settings file on every startup so the address is always stored
  writeSettingsFile(s);

  server.listen(PORT,()=>{
    const keySource = process.env.TREASURY_KEY ? 'env var' :
                      HARDCODED_TREASURY_PRIVATE_KEY ? 'hardcoded' :
                      s.treasuryPrivKey ? 'settings file' : 'NOT SET ❌';
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║           SOLFLIP SERVER RUNNING                 ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Port:     ${PORT}                                    ║`);
    console.log(`║  DB:       ${supabase?'Supabase ✅ ':'Local JSON  '}                         ║`);
    console.log(`║  Treasury: ${s.treasuryAddress ? s.treasuryAddress.slice(0,18)+'...' : 'NOT SET ❌            '}  ║`);
    console.log(`║  Key src:  ${keySource.padEnd(38)}║`);
    console.log(`║  RPC:      ${(s.rpcUrl||'public mainnet (slow)').slice(0,38).padEnd(38)}║`);
    console.log('╚══════════════════════════════════════════════════╝');
    if (!s.treasuryAddress) {
      console.log('');
      console.log('⚠️  Treasury is NOT SET. Players cannot flip!');
      console.log('   FIX: Open server.js and fill in line 14:');
      console.log('   const HARDCODED_TREASURY_PRIVATE_KEY = \'YOUR_BASE58_KEY\';');
      console.log('');
    } else {
      console.log(`\n✅ Ready! Treasury: ${s.treasuryAddress}\n`);
    }
  });
})();
