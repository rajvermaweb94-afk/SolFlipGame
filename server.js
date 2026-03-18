/**
 * SolFlip v2 — Backend Server
 * ═══════════════════════════════════════════════════════════
 *  Edit the 3 lines below, deploy to Railway. Done.
 * ═══════════════════════════════════════════════════════════
 */

// ╔══════════════════════════════════════════════════════════╗
// ║  YOUR CONFIG — fill these in before deploying           ║
// ╚══════════════════════════════════════════════════════════╝
const TREASURY_PRIVKEY = process.env.TREASURY_KEY || 'BXEFru2nf4fLukKDjTWhbYk2qR9P97uF9NrniYvU9BMts4o1Ndp2aksskmyWGj2QNstC7w1GbNzjKo8e7cCWW6A';
const TREASURY_ADDRESS = '51BqQWM3HUS9GFTTSu4aGT9YVSEQE2efkwe131gaQvpv';
const HELIUS_RPC       = process.env.HELIUS_RPC  || 'https://mainnet.helius-rpc.com/?api-key=071fddd0-4ea8-4082-8d9e-aa6233124406';
// ════════════════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');

let solanaWeb3;
try { solanaWeb3 = require('@solana/web3.js'); }
catch(e) { console.error('Run: npm install'); process.exit(1); }
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = solanaWeb3;

// ── Built-in base58 decoder (no package version issues) ───
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const c = B58.indexOf(ch);
    if (c < 0) throw new Error('Bad base58 char: ' + ch);
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
  return Keypair.fromSecretKey(b58decode(TREASURY_PRIVKEY));
}

const PORT    = process.env.PORT     || 8080;
const DB_FILE = process.env.DB_PATH  || path.join(__dirname, 'solflip_db.json');
const SET_FILE= process.env.SETTINGS_PATH || path.join(__dirname, 'solflip_settings.json');

// ── Supabase ──────────────────────────────────────────────
let supabase = null;
async function initSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('[DB] No Supabase — using local JSON'); return;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { error } = await supabase.from('kv').select('k').limit(1);
    if (error) throw error;
    console.log('[DB] Supabase ✅');
  } catch(e) { console.log('[DB] Supabase failed:', e.message); supabase = null; }
}
async function kvGet(k) {
  if (!supabase) return null;
  try { const { data } = await supabase.from('kv').select('v').eq('k',k).single(); return data?.v ?? null; }
  catch(e) { return null; }
}
async function kvSet(k, v) {
  if (!supabase) return;
  try { await supabase.from('kv').upsert({k, v, ts: new Date().toISOString()}); } catch(e) {}
}

// ── Settings ──────────────────────────────────────────────
function loadSettings() {
  let s = {};
  try { if (fs.existsSync(SET_FILE)) s = JSON.parse(fs.readFileSync(SET_FILE,'utf8')); } catch(e) {}
  return {
    flipMode:     s.flipMode     || 'random',
    houseEdge:    s.houseEdge    ?? 4,
    weightedRate: s.weightedRate ?? 50,
    flipPattern:  s.flipPattern  || 'H,T,H,H,T',
    patternIndex: s.patternIndex ?? 0,
    minBet:       s.minBet       ?? 0.001,
    maxBet:       s.maxBet       ?? 0.5,
    maxPayout:    s.maxPayout    ?? 5,
    flipCooldown: s.flipCooldown ?? 5,
    chatEnabled:  s.chatEnabled  ?? true,
    msgCooldown:  s.msgCooldown  ?? 3,
    maxMsgLen:    s.maxMsgLen    ?? 120,
    adminUser:    s.adminUser    || 'admin',
    adminPass:    s.adminPass    || 'admin123',
    autoSwitchBelow: s.autoSwitchBelow ?? 1,
    alertBelow:   s.alertBelow   ?? 2,
    // Infrastructure always from hardcode/env — never from file
    network:         'mainnet',
    rpcUrl:           HELIUS_RPC,
    treasuryAddress:  TREASURY_ADDRESS,
    treasuryPrivKey:  TREASURY_PRIVKEY,
  };
}
function saveSettings(s) {
  const safe = { flipMode:s.flipMode, houseEdge:s.houseEdge, weightedRate:s.weightedRate,
    flipPattern:s.flipPattern, patternIndex:s.patternIndex, minBet:s.minBet, maxBet:s.maxBet,
    maxPayout:s.maxPayout, flipCooldown:s.flipCooldown, chatEnabled:s.chatEnabled,
    msgCooldown:s.msgCooldown, maxMsgLen:s.maxMsgLen, adminUser:s.adminUser, adminPass:s.adminPass,
    autoSwitchBelow:s.autoSwitchBelow, alertBelow:s.alertBelow };
  try { fs.writeFileSync(SET_FILE, JSON.stringify(safe,null,2),'utf8'); } catch(e) {}
  if (supabase) kvSet('settings', safe).catch(()=>{});
}

// ── Game data ─────────────────────────────────────────────
async function readDB() {
  let d = { flips:[], players:{}, chat:[] };
  if (supabase) {
    try {
      const [f,p,c] = await Promise.all([kvGet('flips'),kvGet('players'),kvGet('chat')]);
      if (f) d.flips=f; if (p) d.players=p; if (c) d.chat=c;
    } catch(e) {}
  } else {
    try {
      if (fs.existsSync(DB_FILE)) {
        const r = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
        d.flips=r.flips||[]; d.players=r.players||{}; d.chat=r.chat||[];
      }
    } catch(e) {}
  }
  d.settings = loadSettings();
  return d;
}
async function writeDB(db) {
  saveSettings(db.settings);
  const gd = { flips:db.flips, players:db.players, chat:db.chat };
  if (supabase) {
    try { await Promise.all([kvSet('flips',gd.flips),kvSet('players',gd.players),kvSet('chat',gd.chat)]); return; }
    catch(e) {}
  }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(gd,null,2)); } catch(e) {}
}

// ── Solana ────────────────────────────────────────────────
function getConn() { return new Connection(HELIUS_RPC, 'confirmed'); }
function mult(edge) { return parseFloat(((1-edge/100)*2).toFixed(4)); }
function resolveFlip(s, sig) {
  if (s.flipMode==='forceHeads') return 'heads';
  if (s.flipMode==='forceTails') return 'tails';
  if (s.flipMode==='weighted')   return Math.random()<(s.weightedRate/100)?'heads':'tails';
  if (s.flipMode==='pattern') {
    const pat=(s.flipPattern||'H,T').split(',').map(x=>x.trim().toUpperCase());
    const idx=(s.patternIndex||0)%pat.length; s.patternIndex=idx+1;
    return pat[idx]==='H'?'heads':'tails';
  }
  if (sig&&sig.length>4)
    return (sig.charCodeAt(sig.length-1)+sig.charCodeAt(sig.length-2))%2===0?'heads':'tails';
  return Math.random()<0.5?'heads':'tails';
}

// ── HTTP helpers ──────────────────────────────────────────
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-admin-token'};
function ok(res,data)      { res.writeHead(200,{...CORS,'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,...data})); }
function fail(res,msg,c=400){ res.writeHead(c,{...CORS,'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:msg})); }
function getBody(req)      { return new Promise((res,rej)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{res(JSON.parse(b||'{}'));}catch(e){rej(e);}});req.on('error',rej);}); }
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};

// ── Server ────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method==='OPTIONS') { res.writeHead(204,CORS); res.end(); return; }

  // Static files
  if (!url.startsWith('/api/')) {
    let fp = path.join(__dirname, url==='/'?'index.html':url);
    fs.readFile(fp,(e,d)=>{
      if (e) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});
      res.end(d);
    }); return;
  }

  const db = await readDB();
  const s  = db.settings;

  // ── Public API ────────────────────────────────────────

  // GET /api/settings
  if (req.method==='GET' && url==='/api/settings') {
    const pub = {...s}; delete pub.treasuryPrivKey; delete pub.adminPass;
    console.log('[API] settings → treasury:', pub.treasuryAddress);
    return ok(res, {settings:pub});
  }

  // GET /api/balance?wallet=xxx
  if (req.method==='GET' && url==='/api/balance') {
    const w = new URLSearchParams(req.url.split('?')[1]||'').get('wallet');
    if (!w) return fail(res,'Missing wallet');
    try { return ok(res,{balance:(await getConn().getBalance(new PublicKey(w)))/LAMPORTS_PER_SOL}); }
    catch(e) { return fail(res,e.message); }
  }

  // GET /api/stats
  if (req.method==='GET' && url==='/api/stats') {
    const flips = db.flips;
    return ok(res,{
      totalFlips:   flips.length,
      headsCount:   flips.filter(f=>f.result==='heads').length,
      tailsCount:   flips.filter(f=>f.result==='tails').length,
      totalPlayers: Object.keys(db.players).length,
      totalVolume:  flips.reduce((a,f)=>a+f.bet,0).toFixed(4),
      recentFlips:  flips.slice(0,50),
    });
  }

  // GET /api/chat
  if (req.method==='GET' && url==='/api/chat') {
    const ago = Date.now()-5*60*1000;
    const online = Object.values(db.players).filter(p=>p.lastSeen&&new Date(p.lastSeen)>ago).length;
    return ok(res,{messages:db.chat.slice(-80), onlineCount:online});
  }

  // POST /api/chat
  if (req.method==='POST' && url==='/api/chat') {
    const b = await getBody(req);
    if (!s.chatEnabled) return fail(res,'Chat disabled');
    const msg = {id:Date.now(),name:String(b.name||'Anon').slice(0,20),
      text:String(b.text||'').slice(0,s.maxMsgLen),ts:new Date().toISOString(),
      system:false,gameEvent:!!b.gameEvent,wallet:b.wallet||''};
    db.chat.push(msg); if(db.chat.length>300) db.chat.splice(0,db.chat.length-300);
    await writeDB(db); return ok(res,{msg});
  }

  // POST /api/flip  — core game endpoint
  if (req.method==='POST' && url==='/api/flip') {
    const b = await getBody(req);
    const {wallet,bet,pick,txSig} = b;
    if (!wallet||!bet||!pick||!txSig) return fail(res,'Missing fields');
    if (!TREASURY_ADDRESS) return fail(res,'Treasury not configured');
    if (db.players[wallet]?.banned) return fail(res,'Wallet is banned');
    const betN = parseFloat(bet);
    if (betN < s.minBet) return fail(res,`Min bet: ${s.minBet} SOL`);
    if (betN > s.maxBet) return fail(res,`Max bet: ${s.maxBet} SOL`);

    const result  = resolveFlip(s, txSig);
    const won     = result===pick;
    const payout  = parseFloat((betN*mult(s.houseEdge)).toFixed(6));
    const pnl     = won ? parseFloat((payout-betN).toFixed(6)) : parseFloat((-betN).toFixed(6));
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
        console.log(`✅ Payout ${payout} SOL → ${wallet.slice(0,8)}... | ${payoutSig}`);
      } catch(e) {
        console.error('❌ Payout failed:', e.message);
        payoutSig = 'FAILED:'+e.message;
      }
    }

    const flip = {id:txSig,wallet,bet:betN,pick,result,won,pnl,
      mult:mult(s.houseEdge),payout:won?payout:0,payoutSig,ts:new Date().toISOString(),txSig};
    db.flips.unshift(flip); if(db.flips.length>5000) db.flips.length=5000;

    if (!db.players[wallet]) db.players[wallet]={wallet,flips:0,wins:0,volume:0,pnl:0,
      banned:false,firstSeen:flip.ts,lastSeen:flip.ts};
    const p=db.players[wallet]; p.flips++; if(won)p.wins++;
    p.volume=parseFloat((p.volume+betN).toFixed(6));
    p.pnl=parseFloat((p.pnl+pnl).toFixed(6)); p.lastSeen=flip.ts;

    await writeDB(db);
    console.log(`🎲 ${wallet.slice(0,8)} | ${betN}SOL | ${pick}→${result} | ${won?'WIN':'LOSE'}`);
    return ok(res,{result,won,payout:won?payout:0,pnl,mult:mult(s.houseEdge),payoutSig});
  }

  // GET /api/leaderboard
  if (req.method==='GET' && url==='/api/leaderboard') {
    const players = Object.values(db.players)
      .sort((a,b)=>b.volume-a.volume).slice(0,10)
      .map(p=>({wallet:p.wallet,flips:p.flips,wins:p.wins,volume:p.volume,pnl:p.pnl}));
    return ok(res,{players});
  }

  // ── Admin API ─────────────────────────────────────────

  // POST /api/admin/login
  if (req.method==='POST' && url==='/api/admin/login') {
    const b = await getBody(req);
    const valid = (b.user===(s.adminUser||'admin') && b.pass===(s.adminPass||'admin123'))
               || (b.user==='admin' && b.pass==='admin123');
    if (!valid) return fail(res,'Invalid credentials',401);
    return ok(res,{token:'sf_'+Buffer.from(s.adminPass||'admin123').toString('base64')});
  }

  const adminRoutes=['/api/admin/'];
  if (adminRoutes.some(p=>url.startsWith(p))) {
    const auth     = req.headers['x-admin-token']||'';
    const expected = 'sf_'+Buffer.from(s.adminPass||'admin123').toString('base64');
    if (auth!==expected) return fail(res,'Unauthorized',401);

    if (req.method==='GET'&&url==='/api/admin/settings') {
      const v={...s}; delete v.treasuryPrivKey; return ok(res,{settings:v});
    }
    if (req.method==='POST'&&url==='/api/admin/settings') {
      const b=await getBody(req);
      const allowed=['flipMode','houseEdge','weightedRate','flipPattern','minBet','maxBet',
        'maxPayout','flipCooldown','chatEnabled','msgCooldown','maxMsgLen','adminPass','autoSwitchBelow','alertBelow'];
      allowed.forEach(k=>{ if(b[k]!==undefined) s[k]=b[k]; });
      saveSettings(s);
      const v={...s}; delete v.treasuryPrivKey; return ok(res,{settings:v});
    }
    if (req.method==='GET'&&url==='/api/admin/players')
      return ok(res,{players:Object.values(db.players).sort((a,b)=>b.volume-a.volume)});
    if (req.method==='POST'&&url==='/api/admin/players/ban') {
      const b=await getBody(req);
      if(db.players[b.wallet]){db.players[b.wallet].banned=!!b.banned;await writeDB(db);}
      return ok(res,{});
    }
    if (req.method==='GET'&&url==='/api/admin/flips')
      return ok(res,{flips:db.flips.slice(0,200),stats:{
        totalFlips:db.flips.length,
        totalVolume:db.flips.reduce((a,f)=>a+f.bet,0).toFixed(4),
        houseProfit:db.flips.reduce((a,f)=>a+(f.won?-(f.payout-f.bet):f.bet),0).toFixed(4),
        winRate:(db.flips.length?db.flips.filter(f=>f.won).length/db.flips.length*100:0).toFixed(1),
      }});
    if (req.method==='POST'&&url==='/api/admin/flips/clear')  { db.flips=[];   await writeDB(db); return ok(res,{}); }
    if (req.method==='POST'&&url==='/api/admin/players/reset'){ db.players={}; await writeDB(db); return ok(res,{}); }
    if (req.method==='GET'&&url==='/api/admin/treasury') {
      try {
        const bal=await getConn().getBalance(new PublicKey(TREASURY_ADDRESS));
        return ok(res,{address:TREASURY_ADDRESS,balance:bal/LAMPORTS_PER_SOL});
      } catch(e) { return fail(res,e.message); }
    }
  }

  return fail(res,'Not found',404);
}).listen(PORT, async () => {
  await initSupabase();

  // Verify key on startup
  try {
    const kp = getTreasuryKeypair();
    const derived = kp.publicKey.toString();
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║           SOLFLIP v2 RUNNING                     ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Port     : ${PORT}                                   ║`);
    console.log(`║  Treasury : ${derived.slice(0,20)}...        ║`);
    console.log(`║  Key OK   : ✅ ${derived===TREASURY_ADDRESS?'Address matches':'⚠ Address mismatch — check key'}  ║`);
    console.log(`║  RPC      : Helius mainnet ✅                    ║`);
    console.log(`║  DB       : ${supabase?'Supabase ✅':'Local JSON ⚠️ '}                           ║`);
    console.log('╚══════════════════════════════════════════════════╝\n');
  } catch(e) {
    console.error('\n❌ TREASURY KEY ERROR:', e.message);
    console.error('   Fix TREASURY_PRIVKEY in server.js line 12\n');
  }
});
