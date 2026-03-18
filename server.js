/**
 * SolFlip — Backend Server
 * Keys are hardcoded below. No admin panel or env vars required.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════
//  YOUR PERMANENT CONFIG — edit these three lines only
// ═══════════════════════════════════════════════════════════
const TREASURY_PRIVKEY = process.env.TREASURY_KEY  || 'BXEFru2nf4fLukKDjTWhbYk2qR9P97uF9NrniYvU9BMts4o1Ndp2aksskmyWGj2QNstC7w1GbNzjKo8e7cCWW6A';
const TREASURY_ADDRESS = '51BqQWM3HUS9GFTTSu4aGT9YVSEQE2efkwe131gaQvpv'; // hardcoded — never empty
const HELIUS_RPC       = process.env.HELIUS_RPC    || 'https://mainnet.helius-rpc.com/?api-key=071fddd0-4ea8-4082-8d9e-aa6233124406';
// ═══════════════════════════════════════════════════════════

let solanaWeb3;
try { solanaWeb3 = require('@solana/web3.js'); }
catch(e) { console.error('Run: npm install'); process.exit(1); }
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = solanaWeb3;

// ── Built-in base58 decoder (no bs58 package needed for key decoding) ──
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(str) {
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const c = B58_ALPHA.indexOf(str[i]);
    if (c < 0) throw new Error('Invalid base58 character: ' + str[i]);
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function getTreasuryKeypair() {
  try {
    // Try built-in decoder first (always works, no package dependency)
    return Keypair.fromSecretKey(decodeBase58(TREASURY_PRIVKEY));
  } catch(e) {
    // Fallback: try bs58 package if available
    try {
      const bs58 = require('bs58');
      const decode = typeof bs58.decode === 'function' ? bs58.decode.bind(bs58)
                   : typeof bs58.default?.decode === 'function' ? bs58.default.decode.bind(bs58.default)
                   : null;
      if (decode) return Keypair.fromSecretKey(decode(TREASURY_PRIVKEY));
    } catch(e2) {}
    throw new Error('Cannot decode treasury private key: ' + e.message);
  }
}

const PORT          = process.env.PORT          || 8080;
const DB_FILE       = process.env.DB_PATH       || path.join(__dirname, 'solflip_db.json');
const SETTINGS_FILE = process.env.SETTINGS_PATH || path.join(__dirname, 'solflip_settings.json');

// ── Supabase (optional) ───────────────────────────────────
let supabase = null;
async function initSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('[DB] No Supabase creds — using local JSON'); return;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { error } = await supabase.from('kv').select('k').limit(1);
    if (error) throw error;
    console.log('[DB] Supabase connected ✅');
  } catch(e) { console.log('[DB] Supabase failed:', e.message); supabase = null; }
}
async function kvGet(k) {
  if (!supabase) return null;
  try { const { data } = await supabase.from('kv').select('v').eq('k',k).single(); return data?.v ?? null; }
  catch(e) { return null; }
}
async function kvSet(k, v) {
  if (!supabase) return;
  try { await supabase.from('kv').upsert({k, v, ts: new Date().toISOString()}); }
  catch(e) {}
}

// ── Settings ──────────────────────────────────────────────
// treasuryAddress is ALWAYS the hardcoded constant — never read from file
function loadSettings() {
  let saved = {};
  try {
    if (fs.existsSync(SETTINGS_FILE))
      saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch(e) {}

  return {
    // Game settings — these can come from saved file
    flipMode:        saved.flipMode        || 'random',
    houseEdge:       saved.houseEdge       ?? 4,
    weightedRate:    saved.weightedRate    ?? 50,
    flipPattern:     saved.flipPattern     || 'H,T,H,H,T',
    patternIndex:    saved.patternIndex    ?? 0,
    minBet:          saved.minBet          ?? 0.001,
    maxBet:          saved.maxBet          ?? 0.5,
    maxPayout:       saved.maxPayout       ?? 5,
    flipCooldown:    saved.flipCooldown    ?? 5,
    chatEnabled:     saved.chatEnabled     ?? true,
    msgCooldown:     saved.msgCooldown     ?? 3,
    maxMsgLen:       saved.maxMsgLen       ?? 120,
    adminUser:       saved.adminUser       || 'admin',
    adminPass:       saved.adminPass       || 'admin123',
    autoSwitchBelow: saved.autoSwitchBelow ?? 1,
    alertBelow:      saved.alertBelow      ?? 2,
    // Infrastructure — ALWAYS use hardcoded/env values, NEVER from saved file
    network:          'mainnet',
    rpcUrl:           HELIUS_RPC,
    treasuryPrivKey:  TREASURY_PRIVKEY,
    treasuryAddress:  TREASURY_ADDRESS,   // ← always hardcoded, never empty
  };
}

function saveSettings(s) {
  // Only save game settings — never save infrastructure keys to file
  const toSave = {
    flipMode: s.flipMode, houseEdge: s.houseEdge, weightedRate: s.weightedRate,
    flipPattern: s.flipPattern, patternIndex: s.patternIndex,
    minBet: s.minBet, maxBet: s.maxBet, maxPayout: s.maxPayout,
    flipCooldown: s.flipCooldown, chatEnabled: s.chatEnabled,
    msgCooldown: s.msgCooldown, maxMsgLen: s.maxMsgLen,
    adminUser: s.adminUser, adminPass: s.adminPass,
    autoSwitchBelow: s.autoSwitchBelow, alertBelow: s.alertBelow,
  };
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toSave, null, 2), 'utf8'); }
  catch(e) { console.error('[SETTINGS] Write error:', e.message); }
  if (supabase) kvSet('settings', toSave).catch(() => {});
}

// ── Game data ─────────────────────────────────────────────
async function readGameData() {
  let d = { flips:[], players:{}, chat:[] };
  if (supabase) {
    try {
      const [f,p,c] = await Promise.all([kvGet('flips'),kvGet('players'),kvGet('chat')]);
      if (f) d.flips = f; if (p) d.players = p; if (c) d.chat = c;
    } catch(e) {}
  } else {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
        d.flips = raw.flips||[]; d.players = raw.players||{}; d.chat = raw.chat||[];
      }
    } catch(e) {}
  }
  return d;
}
async function writeGameData(d) {
  if (supabase) {
    try { await Promise.all([kvSet('flips',d.flips),kvSet('players',d.players),kvSet('chat',d.chat)]); return; }
    catch(e) {}
  }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2)); } catch(e) {}
}
async function readDB() {
  const gd = await readGameData();
  return { settings: loadSettings(), ...gd };
}
async function writeDB(db) {
  saveSettings(db.settings);
  await writeGameData({ flips:db.flips, players:db.players, chat:db.chat });
}

// ── Solana helpers ────────────────────────────────────────
function getConn()        { return new Connection(HELIUS_RPC, 'confirmed'); }
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
  if (txSig&&txSig.length>4)
    return (txSig.charCodeAt(txSig.length-1)+txSig.charCodeAt(txSig.length-2))%2===0?'heads':'tails';
  return Math.random()<0.5?'heads':'tails';
}

// ── HTTP helpers ──────────────────────────────────────────
function ok(res,data)     { res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({ok:true,...data})); }
function err(res,msg,c=400){ res.writeHead(c,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({ok:false,error:msg})); }
function body(req) { return new Promise((res,rej)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{res(JSON.parse(b||'{}'));}catch(e){rej(e);}});req.on('error',rej);}); }
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-admin-token'});
    res.end(); return;
  }
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

  // GET /api/settings — frontend uses this to get treasury address
  if (req.method==='GET' && url==='/api/settings') {
    const pub = Object.assign({}, s);
    delete pub.treasuryPrivKey; delete pub.adminPass;
    console.log('[API] /api/settings — treasuryAddress:', pub.treasuryAddress);
    return ok(res, { settings: pub });
  }

  if (req.method==='GET' && url==='/api/balance') {
    const w = req.url.split('wallet=')[1];
    if(!w) return err(res,'Missing wallet');
    try { return ok(res,{balance:(await getConn().getBalance(new PublicKey(w.split('&')[0])))/LAMPORTS_PER_SOL}); }
    catch(e){ return err(res,e.message); }
  }

  if (req.method==='GET' && url==='/api/stats') {
    return ok(res,{
      totalFlips:db.flips.length,
      headsCount:db.flips.filter(f=>f.result==='heads').length,
      tailsCount:db.flips.filter(f=>f.result==='tails').length,
      totalPlayers:Object.keys(db.players).length,
      recentFlips:db.flips.slice(0,30),
    });
  }

  if (req.method==='GET' && url==='/api/chat') {
    const ago = Date.now()-5*60*1000;
    const onlineCount = Object.values(db.players).filter(p=>p.lastSeen&&new Date(p.lastSeen).getTime()>ago).length;
    return ok(res,{messages:db.chat.slice(-60),onlineCount});
  }

  if (req.method==='POST' && url==='/api/chat') {
    const b = await body(req);
    if(!s.chatEnabled) return err(res,'Chat disabled');
    const msg={id:Date.now(),name:String(b.name||'Anon').slice(0,20),text:String(b.text||'').slice(0,s.maxMsgLen||120),ts:new Date().toISOString(),system:false,gameEvent:!!b.gameEvent};
    db.chat.push(msg); if(db.chat.length>300) db.chat.splice(0,db.chat.length-300);
    await writeDB(db); return ok(res,{msg});
  }

  if (req.method==='POST' && url==='/api/flip') {
    const b = await body(req);
    const {wallet,bet,pick,txSig} = b;
    if(!wallet||!bet||!pick||!txSig) return err(res,'Missing fields');
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
        const conn  = getConn();
        const treas = getTreasuryKeypair();
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
    db.flips.unshift(flip); if(db.flips.length>5000) db.flips.length=5000;
    if(!db.players[wallet]) db.players[wallet]={wallet,flips:0,wins:0,volume:0,pnl:0,banned:false,firstSeen:flip.ts,lastSeen:flip.ts};
    const p=db.players[wallet]; p.flips++; if(won)p.wins++;
    p.volume=parseFloat((p.volume+bet).toFixed(6)); p.pnl=parseFloat((p.pnl+pnl).toFixed(6)); p.lastSeen=flip.ts;
    await writeDB(db);
    console.log(`🎲 ${wallet.slice(0,8)} ${bet}SOL ${pick}→${result} ${won?'WIN':'LOSE'}`);
    return ok(res,{result,won,payout:won?payout:0,pnl,mult,payoutSig});
  }

  if (req.method==='POST' && url==='/api/admin/login') {
    const b = await body(req);
    const valid = (b.user===(s.adminUser||'admin') && b.pass===(s.adminPass||'admin123'))
               || (b.user==='admin' && b.pass==='admin123');
    if(!valid) return err(res,'Invalid credentials',401);
    return ok(res,{token:'sf_'+Buffer.from(s.adminPass||'admin123').toString('base64')});
  }

  const adminPaths=['/api/admin/settings','/api/admin/players','/api/admin/flips','/api/admin/treasury'];
  if(adminPaths.some(p=>url.startsWith(p))) {
    const auth     = req.headers['x-admin-token']||'';
    const expected = 'sf_'+Buffer.from(s.adminPass||'admin123').toString('base64');
    if(auth!==expected) return err(res,'Unauthorized',401);

    if(req.method==='GET'&&url==='/api/admin/settings') {
      const v=Object.assign({},s); delete v.treasuryPrivKey;
      return ok(res,{settings:v});
    }
    if(req.method==='POST'&&url==='/api/admin/settings') {
      const b=await body(req);
      // Only allow game settings — infrastructure is hardcoded
      const allowed=['flipMode','houseEdge','weightedRate','flipPattern','minBet','maxBet',
        'maxPayout','flipCooldown','chatEnabled','msgCooldown','maxMsgLen','adminPass',
        'autoSwitchBelow','alertBelow'];
      allowed.forEach(k=>{ if(b[k]!==undefined) s[k]=b[k]; });
      saveSettings(s);
      const v=Object.assign({},s); delete v.treasuryPrivKey;
      return ok(res,{settings:v});
    }
    if(req.method==='GET'&&url==='/api/admin/players') return ok(res,{players:Object.values(db.players)});
    if(req.method==='POST'&&url==='/api/admin/players/ban'){
      const b=await body(req);
      if(db.players[b.wallet]){db.players[b.wallet].banned=!!b.banned; await writeDB(db);}
      return ok(res,{});
    }
    if(req.method==='GET'&&url==='/api/admin/flips') return ok(res,{flips:db.flips.slice(0,100),stats:{
      totalFlips:db.flips.length,
      totalVolume:db.flips.reduce((a,f)=>a+f.bet,0).toFixed(4),
      houseProfit:db.flips.reduce((a,f)=>a+(f.won?-(f.payout-f.bet):f.bet),0).toFixed(4),
    }});
    if(req.method==='POST'&&url==='/api/admin/flips/clear')  { db.flips=[];   await writeDB(db); return ok(res,{}); }
    if(req.method==='POST'&&url==='/api/admin/players/reset'){ db.players={}; await writeDB(db); return ok(res,{}); }
    if(req.method==='GET'&&url==='/api/admin/treasury/balance') {
      try {
        const bal = await getConn().getBalance(new PublicKey(TREASURY_ADDRESS));
        return ok(res,{balance:bal/LAMPORTS_PER_SOL, address:TREASURY_ADDRESS});
      } catch(e){ return err(res,e.message); }
    }
  }

  return err(res,'Unknown endpoint',404);
});

// ── Startup ───────────────────────────────────────────────
(async()=>{
  await initSupabase();

  // Delete any stale settings file that might have empty treasuryAddress
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'));
      if (!old.treasuryAddress || old.treasuryAddress !== TREASURY_ADDRESS) {
        console.log('[BOOT] Removing stale settings file — keys will use hardcoded values');
        fs.unlinkSync(SETTINGS_FILE);
      }
    } catch(e) { try { fs.unlinkSync(SETTINGS_FILE); } catch(e2) {} }
  }

  // Verify treasury key decodes correctly
  let verifiedAddress = TREASURY_ADDRESS;
  try {
    const kp = getTreasuryKeypair();
    verifiedAddress = kp.publicKey.toString();
    console.log('[BOOT] ✅ Treasury key decoded OK');
    console.log('[BOOT]    Derived address :', verifiedAddress);
    console.log('[BOOT]    Hardcoded address:', TREASURY_ADDRESS);
    if (verifiedAddress !== TREASURY_ADDRESS) {
      console.warn('[BOOT] ⚠️  Derived address differs from hardcoded! Check your private key.');
    }
  } catch(e) {
    console.error('[BOOT] ❌ Key decode failed:', e.message);
    console.log('[BOOT]    Will use hardcoded address for frontend:', TREASURY_ADDRESS);
  }

  server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║              SOLFLIP SERVER RUNNING                  ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Port    : ${PORT}                                        ║`);
    console.log(`║  Treasury: ${TREASURY_ADDRESS}  ║`);
    console.log(`║  RPC     : ${HELIUS_RPC.slice(0,40)}... ║`);
    console.log(`║  DB      : ${supabase ? 'Supabase ✅' : 'Local JSON'}                                  ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('\n✅ Treasury address hardcoded — will always be set\n');
  });
})();
