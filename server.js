/**
 * SolFlip — Backend Server with Supabase + Local JSON fallback
 *
 * ENV VARS (set in Railway Variables):
 *   SUPABASE_URL  = https://xxxx.supabase.co
 *   SUPABASE_KEY  = your-service-role-key  (NOT anon key)
 *   TREASURY_KEY  = base58-private-key
 *   HELIUS_RPC    = https://mainnet.helius-rpc.com/?api-key=xxx
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

// Solana
let solanaWeb3, bs58;
try { solanaWeb3=require('@solana/web3.js'); bs58=require('bs58'); }
catch(e) { console.error('Run: npm install'); process.exit(1); }
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } = solanaWeb3;

const PORT    = process.env.PORT    || 8080;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'solflip_db.json');

// ── Supabase ─────────────────────────────────────────────
let supabase = null;
async function initSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('[DB] No Supabase creds — using local JSON file');
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

// ── KV helpers ───────────────────────────────────────────
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

// ── Default settings ─────────────────────────────────────
function defaultSettings() {
  return {
    flipMode:'random', houseEdge:4, weightedRate:50,
    flipPattern:'H,T,H,H,T', patternIndex:0,
    minBet:0.001, maxBet:0.5, maxPayout:5, flipCooldown:5,
    network:'mainnet',
    rpcUrl:   process.env.HELIUS_RPC   || '',
    treasuryPrivKey: process.env.TREASURY_KEY || '',
    treasuryAddress: '',
    chatEnabled:true, msgCooldown:3, maxMsgLen:120,
    adminUser:'admin', adminPass:'admin123',
    autoSwitchBelow:1, alertBelow:2,
  };
}

// ── Apply env overrides (always wins) ────────────────────
function applyEnv(s) {
  if (process.env.HELIUS_RPC) {
    s.rpcUrl  = process.env.HELIUS_RPC;
    s.network = 'custom';
  }
  if (process.env.TREASURY_KEY) {
    s.treasuryPrivKey = process.env.TREASURY_KEY;
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_KEY));
      s.treasuryAddress = kp.publicKey.toString();
    } catch(e) {
      console.error('[ENV] TREASURY_KEY decode failed:', e.message);
      console.error('[ENV] Key length:', process.env.TREASURY_KEY.length);
    }
  }
  // Also derive address from saved privKey if address still empty
  if (!s.treasuryAddress && s.treasuryPrivKey) {
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(s.treasuryPrivKey));
      s.treasuryAddress = kp.publicKey.toString();
    } catch(e) {}
  }
  return s;
}

// ── Read/Write DB ─────────────────────────────────────────
async function readDB() {
  let db = { settings: defaultSettings(), flips:[], players:{}, chat:[] };

  if (supabase) {
    try {
      const [settings, flips, players, chat] = await Promise.all([
        kvGet('settings'), kvGet('flips'), kvGet('players'), kvGet('chat')
      ]);
      if (settings) db.settings = Object.assign({}, defaultSettings(), settings);
      if (flips)   db.flips   = flips;
      if (players) db.players = players;
      if (chat)    db.chat    = chat;
    } catch(e) { console.error('[DB] read error:', e.message); }
  } else {
    // Local JSON
    try {
      if (fs.existsSync(DB_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
        db.settings = Object.assign({}, defaultSettings(), saved.settings||{});
        db.flips    = saved.flips   || [];
        db.players  = saved.players || {};
        db.chat     = saved.chat    || [];
      }
    } catch(e) {}
  }

  // Always apply env on top
  applyEnv(db.settings);
  return db;
}

async function writeDB(db) {
  // Always apply env before saving
  applyEnv(db.settings);

  if (supabase) {
    try {
      await Promise.all([
        kvSet('settings', db.settings),
        kvSet('flips',    db.flips),
        kvSet('players',  db.players),
        kvSet('chat',     db.chat),
      ]);
      return;
    } catch(e) { console.error('[DB] write error:', e.message); }
  }

  // Local JSON fallback
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
  catch(e) { console.error('[DB] local write error:', e.message); }
}

// ── Solana ────────────────────────────────────────────────
function getConn(s) {
  const url = s.rpcUrl || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}
function getTreasury(s) {
  const key = s.treasuryPrivKey;
  if (!key) throw new Error('Treasury private key not set — add TREASURY_KEY in Railway Variables');
  try { return Keypair.fromSecretKey(bs58.decode(key)); }
  catch(e) { throw new Error('Invalid TREASURY_KEY — must be base58 private key'); }
}
function multiplier(edge) { return parseFloat(((1-edge/100)*2).toFixed(4)); }
function resolveFlip(s, txSig) {
  if (s.flipMode==='forceHeads') return 'heads';
  if (s.flipMode==='forceTails') return 'tails';
  if (s.flipMode==='weighted') return Math.random()<(s.weightedRate/100)?'heads':'tails';
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

// ── Server ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-admin-token'});
    res.end(); return;
  }

  if (!url.startsWith('/api/')) {
    // Static files
    const fp = path.join(__dirname, url==='/'?'index.html':url);
    fs.readFile(fp,(e,d)=>{
      if(e){res.writeHead(e.code==='ENOENT'?404:500);res.end(e.code==='ENOENT'?'Not found':'Server error');return;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});
      res.end(d);
    }); return;
  }

  // ── API ───────────────────────────────────────────────
  const db = await readDB();
  const s  = db.settings;

  // GET /api/settings
  if (req.method==='GET' && url==='/api/settings') {
    const pub = Object.assign({}, s);
    // Final safety: if we have any private key, derive address now
    const privKey = process.env.TREASURY_KEY || s.treasuryPrivKey;
    if (privKey && !pub.treasuryAddress) {
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(privKey));
        pub.treasuryAddress = kp.publicKey.toString();
        // Also persist this fix to DB
        s.treasuryAddress = pub.treasuryAddress;
        writeDB(db).catch(()=>{});
        console.log('[SETTINGS] Treasury address auto-fixed:', pub.treasuryAddress);
      } catch(e) {
        console.error('[SETTINGS] Cannot derive treasury address:', e.message);
      }
    }
    delete pub.treasuryPrivKey; delete pub.adminPass;
    console.log('[SETTINGS] Serving settings. treasuryAddress:', pub.treasuryAddress || 'EMPTY');
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

    if(req.method==='GET'&&url==='/api/admin/settings') return ok(res,{settings:s});

    if(req.method==='POST'&&url==='/api/admin/settings') {
      const b=await body(req);
      Object.assign(s,b);
      if(b.treasuryPrivKey){
        try{const kp=Keypair.fromSecretKey(bs58.decode(b.treasuryPrivKey));s.treasuryAddress=kp.publicKey.toString();console.log('[SETTINGS] Treasury:',s.treasuryAddress);}
        catch(e){return err(res,'Invalid private key (must be base58)');}
      }
      applyEnv(s);
      await writeDB(db);
      console.log('[SETTINGS] Saved. Treasury:',s.treasuryAddress||'NOT SET','RPC:',s.rpcUrl?'custom':'default');
      return ok(res,{settings:s});
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
        if(!addr) return err(res,'No treasury address — set TREASURY_KEY in Railway');
        const bal=await getConn(s).getBalance(new PublicKey(addr));
        return ok(res,{balance:bal/LAMPORTS_PER_SOL,address:addr});
      }catch(e){return err(res,e.message);}
    }
  }

  return err(res,'Unknown endpoint',404);
});

(async()=>{
  await initSupabase();
  const db = await readDB();
  applyEnv(db.settings);
  await writeDB(db);

  server.listen(PORT,()=>{
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        SOLFLIP SERVER RUNNING            ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Port:     ${PORT}                            ║`);
    console.log(`║  DB:       ${supabase?'Supabase ✅           ':'Local JSON ⚠️           '}║`);
    console.log(`║  Treasury: ${db.settings.treasuryAddress?'SET ✅':'NOT SET ❌ — add TREASURY_KEY'}      ║`);
    console.log(`║  RPC:      ${db.settings.rpcUrl?'Helius ✅ ':'Public (slow) ⚠️'}                  ║`);
    console.log('╚══════════════════════════════════════════╝');
    if(!db.settings.treasuryAddress) console.log('\n⚠️  Add TREASURY_KEY env var in Railway!\n');
  });
})();
