import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import cron from 'node-cron';
import Groq, { toFile } from 'groq-sdk';
import admin from 'firebase-admin';
import ffmpegPath from 'ffmpeg-static';
import { readFileSync, existsSync, promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const PORT = Number(process.env.PORT || 10000);
const BOT_NAME = process.env.BOT_NAME || 'HBOT';
const CREATOR_NAME = process.env.CREATOR_NAME || 'ASSAMOI Yapi Hyppolite informaticien développeur d’applications';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';
const VOICE_REPLY_ENABLED = String(process.env.VOICE_REPLY_ENABLED ?? 'true').toLowerCase() === 'true';
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID || '22567647800-1546850208@g.us';
const MAX_HISTORY = 12;
const MAX_CONVERSATIONS = 500;
const MAX_GROUP_MEMORY = 120;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const TIME_ZONE = 'Africa/Abidjan';

let sock = null;
let latestQR = null;
let qrDataURL = null;
let whatsappConnected = false;
let connexionEnCours = false;
let connectionGeneration = 0;
const conversations = new Map();

const LISTE_OFFICIELLE_MEMBRES = [
  "Respo Joanna",
  "Chantre Lili",
  "Chantre Sea Franck",
  "Respo Assamoi",
  "Chantre madame Assamoi",
  "Respo Armand",
  "Maestro Ange",
  "Chantre Maman Anne",
  "Chantre maman DIBY",
  "Chantre Berenice",
  "Chantre Nancy",
  "Chantre Maman Diallo",
  "Maestro issouph",
  "Chantre Koulate jean Christ",
  "Chantre maman M’BROH",
  "Maestro Samuel",
  "Chantre Marina",
  "RESPO DJE",
  "Chantre Stéphane"
];


let groq = null;
if (GROQ_API_KEY) {
  groq = new Groq({ apiKey: GROQ_API_KEY });
  console.log('✅ Clé Groq configurée.');
}

let db = null;
try {
  if (!admin.apps.length) {
    const candidates = ['/etc/secrets/serviceAccountKey.json','./serviceAccountKey.json'];
    const serviceAccountPath = candidates.find(file => existsSync(file));
    if (serviceAccountPath) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8'))) });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    }
  }
  if (admin.apps.length) db = admin.firestore();
} catch (error) {
  console.error('❌ Erreur Firebase :', error.message);
}

async function useFirebaseAuthState() {
  const baseDir = AUTH_DIR;
  if (!existsSync(baseDir)) await fs.mkdir(baseDir, { recursive: true });
  const readData = async (file) => {
    try {
      if (db) {
        const docRef = db.collection('whatsapp_auth').doc(file.replace(/[/\\.]/g, '_'));
        const doc = await docRef.get();
        if (doc.exists && doc.data()?.content) {
          return JSON.parse(doc.data().content, (k, v) => v?.type === 'Buffer' ? Buffer.from(v.data) : v);
        }
      }
      const filePath = path.join(baseDir, file);
      if (existsSync(filePath)) return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (e) { console.error(`Erreur lecture auth ${file}:`, e.message); }
    return null;
  };
  const writeData = async (data, file) => {
    try {
      const filePath = path.join(baseDir, file);
      const stringified = JSON.stringify(data, (k, v) => v instanceof Buffer ? { type: 'Buffer', data: Array.from(v) } : v);
      await fs.writeFile(filePath, stringified, 'utf8');
      if (db) {
        await db.collection('whatsapp_auth').doc(file.replace(/[/\\.]/g, '_')).set({ content: stringified, updatedAt: new Date() });
      }
    } catch (e) { console.error(`Erreur écriture auth ${file}:`, e.message); }
  };
  const creds = (await readData('creds.json')) || (await import('@whiskeysockets/baileys')).initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) data[id] = await readData(`${type}-${id}.json`);
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              tasks.push(data[category][id] ? writeData(data[category][id], `${category}-${id}.json`) : fs.unlink(path.join(AUTH_DIR, `${category}-${id}.json`)).catch(()=>{}));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds.json')
  };
}

const SYSTEM_PROMPT = `Tu es ${BOT_NAME}, un assistant WhatsApp intelligent, chaleureux et bienveillant, créé et développé par ${CREATOR_NAME}. Réponds en français simple et naturel avec modération d'emojis.`;

function nettoyerTexte(texte = '') { return String(texte).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim(); }
function obtenirDateAbidjan(date = new Date()) { return new Intl.DateTimeFormat('fr-FR', { timeZone: TIME_ZONE, day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }).format(date); }
function obtenirMessageReel(message) {
  let contenu = message?.message;
  while (contenu) {
    if (contenu.ephemeralMessage?.message) { contenu = contenu.ephemeralMessage.message; continue; }
    if (contenu.viewOnceMessage?.message) { contenu = contenu.viewOnceMessage.message; continue; }
    if (contenu.viewOnceMessageV2?.message) { contenu = contenu.viewOnceMessageV2.message; continue; }
    break;
  }
  return contenu || {};
}
function obtenirTexteMessage(message) {
  const contenu = obtenirMessageReel(message);
  return (contenu.conversation || contenu.extendedTextMessage?.text || contenu.imageMessage?.caption || contenu.videoMessage?.caption || '').trim();
}
function estCommande(texte = '') { return /^!(aide|help|id|resetia|programme|cotisation|cotisations|c|setprogramme|retard|impayes)\b/i.test(texte.trim()); }
function estMessageDeMoi(message) { return message?.key?.fromMe === true; }
function estMessageDeGroupe(message) { return String(message?.key?.remoteJid || '').endsWith('@g.us'); }
function obtenirConversationId(message) { const jid = message?.key?.remoteJid || ''; const p = message?.key?.participant || ''; return estMessageDeGroupe(message) ? `${jid}:${p}` : jid; }
function obtenirJid(message) { return message?.key?.remoteJid || ''; }
function estMentionBot(texte = '') { return /\b(h-?bot)\b/i.test(texte.toLowerCase()); }
function estReponseAuBot(message) {
  const contenu = obtenirMessageReel(message);
  const ctx = contenu.extendedTextMessage?.contextInfo || contenu.imageMessage?.contextInfo;
  if (!ctx?.stanzaId) return false;
  return ctx?.participant === sock?.user?.id;
}
function estMessageAudio(message) { const c = obtenirMessageReel(message); return Boolean(c.audioMessage || c.pttMessage); }

function obtenirHistorique(id) { if (!conversations.has(id)) conversations.set(id, []); return conversations.get(id); }
function ajouterHistorique(id, role, content) {
  const h = obtenirHistorique(id);
  h.push({ role, content });
  while (h.length > MAX_HISTORY * 2) h.shift();
}
function reinitialiserHistorique(id) { conversations.delete(id); }

async function genererIA(texte, conversationId, options = {}) {
  if (!groq) return 'Service IA non configuré.';
  const historique = obtenirHistorique(conversationId);
  try {
    const reponse = await groq.chat.completions.create({
      model: options.model || GROQ_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...historique, { role: 'user', content: texte }],
      max_completion_tokens: 1200
    });
    const resultat = nettoyerTexte(reponse.choices?.[0]?.message?.content || '');
    ajouterHistorique(conversationId, 'user', texte);
    ajouterHistorique(conversationId, 'assistant', resultat);
    return resultat;
  } catch { return 'Je rencontre un problème technique.'; }
}

async function envoyerTexte(jid, texte) {
  if (!sock || !whatsappConnected) return false;
  try { await sock.sendMessage(jid, { text: String(texte) }); return true; } catch { return false; }
}
async function envoyerReponse(jid, texte, messageOriginal = null) {
  if (!sock || !whatsappConnected) return false;
  try {
    const options = messageOriginal?.key ? { quoted: messageOriginal } : {};
    await sock.sendMessage(jid, { text: texte, ...options });
    return true;
  } catch { return false; }
}
async function telechargerMedia(message, type) {
  const contenu = obtenirMessageReel(message);
  const media = type === 'audio' ? (contenu.audioMessage || contenu.pttMessage) : contenu.imageMessage;
  const stream = await downloadContentFromMessage(media, type);
  const morceaux = []; for await (const m of stream) morceaux.push(m);
  return Buffer.concat(morceaux);
}
async function transcrireAudio(buffer) {
  const fichier = await toFile(buffer, 'message.ogg', { type: 'audio/ogg' });
  const resultat = await groq.audio.transcriptions.create({ file: fichier, model: WHISPER_MODEL, language: 'fr', response_format: 'text' });
  return typeof resultat === 'string' ? resultat : resultat.text || '';
}
async function genererAudioElevenLabs(texte) {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(nettoyerTexte(texte).slice(0, 200))}&tl=fr&client=tw-ob`;
  const reponse = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return Buffer.from(await reponse.arrayBuffer());
}
async function convertirMp3EnOgg(mp3Buffer) {
  const dossier = await fs.mkdtemp(path.join(os.tmpdir(), 'hbot-'));
  const mp3Path = path.join(dossier, 'input.mp3');
  const oggPath = path.join(dossier, 'output.ogg');
  try {
    await fs.writeFile(mp3Path, mp3Buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, ['-y', '-i', mp3Path, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', oggPath]);
      proc.on('close', code => code === 0 ? resolve() : reject());
    });
    return await fs.readFile(oggPath);
  } finally { await fs.rm(dossier, { recursive: true, force: true }); }
}
async function envoyerReponseVocale(jid, texte, messageOriginal = null) {
  if (!VOICE_REPLY_ENABLED) return envoyerReponse(jid, texte, messageOriginal);
  try {
    const mp3 = await genererAudioElevenLabs(texte);
    const ogg = await convertirMp3EnOgg(mp3);
    await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, quoted: messageOriginal });
    return true;
  } catch { return envoyerReponse(jid, texte, messageOriginal); }
}

function encoderJid(jid) { return Buffer.from(jid).toString('base64url'); }
async function ajouterMemoireGroupe(jid, texte) {
  if (!db || !jid || !texte) return;
  try {
    const ref = db.collection('hbot2_group_memory').doc(encoderJid(jid));
    await db.runTransaction(async t => {
      const snap = await t.get(ref);
      const old = snap.exists ? snap.data().items || [] : [];
      const items = [...old, { text: texte.slice(0, 1000), date: new Date().toISOString() }].slice(-MAX_GROUP_MEMORY);
      t.set(ref, { jid, items, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch {}
}
async function lireMemoireGroupe(jid) {
  if (!db) return [];
  try { const s = await db.collection('hbot2_group_memory').doc(encoderJid(jid)).get(); return s.exists ? s.data().items || [] : []; } catch { return []; }
}

function obtenirNomTransaction(data) { return String(data.name || data.memberName || data.nom || data.member || data.membre || 'Membre').trim(); }
function obtenirMontantTransaction(data) { return Number(data.amount || data.montant || 0); }
function formaterMontant(montant) { return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(montant); }

async function getCotisationsReport() {
  if (!db) return '⚠️ Firebase indisponible.';
  try {
    const snapshot = await db.collection('transactions').limit(200).get();
    if (snapshot.empty) return '📊 *TOTAL DES COTISATIONS* 🪙\nAucune cotisation enregistrée.';
    const totauxParMembre = {};
    let joannaTotal = 0;
    let nomExactJoanna = 'Respo Joanna';
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      const nomBrut = obtenirNomTransaction(data);
      const montant = obtenirMontantTransaction(data);
      if (nomBrut.toLowerCase().includes('joanna')) {
        joannaTotal += montant;
        if (nomBrut.length > nomExactJoanna.length) nomExactJoanna = nomBrut;
      } else {
        totauxParMembre[nomBrut] = (totauxParMembre[nomBrut] || 0) + montant;
      }
    });
    const autres = Object.keys(totauxParMembre).map(nom => ({ nom, total: totauxParMembre[nom] })).sort((a,b)=>b.total-a.total);
    const classement = [];
    if (joannaTotal > 0) classement.push({ nom: nomExactJoanna, total: joannaTotal });
    classement.push(...autres);
    const lignes = classement.map((item, index) => `${index===0?'🥇':'✅'} *${item.nom}* : *${formaterMontant(item.total)} FCFA*`);
    return ['📊 *TOTAL DES COTISATIONS PAR MEMBRE* 🪙','',...lignes,'','💡 Merci pour votre fidélité ! 🙏✨'].join('\n');
  } catch { return '❌ Erreur récupération cotisations.'; }
}

async function getImpayesReport() {
  if (!db) return '⚠️ Firebase indisponible.';
  try {
    const snapshot = await db.collection('transactions').limit(200).get();
    const payeursSet = new Set();
    snapshot.docs.forEach(doc => {
      const nom = obtenirNomTransaction(doc.data());
      if (nom) payeursSet.add(String(nom).toLowerCase().trim());
    });
    const impayes = LISTE_OFFICIELLE_MEMBRES.filter(membre => {
      const nomMembre = membre.toLowerCase().trim();
      return !Array.from(payeursSet).some(payeur => payeur.includes(nomMembre));
    });
    if (impayes.length === 0) return '🎉 Tout le monde a payé sa cotisation !';
    return ['⏳ *PERSONNES EN RETARD (IMPAYÉS)* ⚠️','',...impayes.map(m=>`❌ *${m}*`),'',`Total : ${impayes.length} personne(s)`].join('\n');
  } catch { return '❌ Erreur rapport retards.'; }
}

let texteProgrammeMois = `⛪ *ÉGLISE DES ASSEMBLÉES DE DIEU ABOBO BELLEVILLE - TEMPLE LA RESTAURATION DIVINE*\n\n📅 *PROGRAMME NOVEMBRE ET DÉCEMBRE*\n\n🔴 *NOVEMBRE*\n• *01/11/26* : Adoration: Anne | Célébration: Nancy\n• *08/11/26* : Adoration: Joanne | Célébration: Mme M'Bro\n• *15/11/26* : Adoration: Nancy | Célébration: Anne\n• *22/11/26* : Adoration: Berenice | Célébration: Mme Diallo\n• *29/11/26* : Adoration: Mme M'Bro | Célébration: Marie Ange\n\n🟢 *DÉCEMBRE*\n• *06/12/26* : Adoration: Mme Diallo | Célébration: Berenice\n• *13/12/26* : Adoration: Nancy | Célébration: Joanne\n• *20/12/26* : Adoration: Marie Ange | Célébration: Mme Diallo\n• *27/12/26* : Adoration: Joanne | Célébration: Anne`;

async function traiterCommande(jid, texte, message) {
  const commande = texte.trim().split(/\s+/)[0].toLowerCase();
  switch (commande) {
    case '!aide': case '!help':
      await envoyerReponse(jid, `🤖 *COMMANDES HBOT*\n🆔 !id\n🧠 !resetia\n📅 !programme\n🪙 !cotisation / !c\n⚠️ !retard / !impayes`, message); return true;
    case '!id': await envoyerReponse(jid, `🆔 ID : ${jid}`, message); return true;
    case '!resetia': reinitialiserHistorique(obtenirConversationId(message)); await envoyerReponse(jid, '🧠 Mémoire réinitialisée !', message); return true;
    case '!programme': await envoyerReponse(jid, texteProgrammeMois, message); return true;
    case '!cotisation': case '!cotisations': case '!c': await envoyerReponse(jid, await getCotisationsReport(), message); return true;
    case '!retard': case '!impayes': await envoyerReponse(jid, await getImpayesReport(), message); return true;
    default: return false;
  }
}

async function traiterMessage(message) {
  if (!message?.message || estMessageDeMoi(message)) return;
  const jid = obtenirJid(message);
  if (!jid || jid === 'status@broadcast') return;
  const texte = obtenirTexteMessage(message);
  const groupe = estMessageDeGroupe(message);
  const commande = estCommande(texte);
  const mention = estMentionBot(texte);
  const reponseAuBot = estReponseAuBot(message);
  
  if (groupe && !commande && !mention && !reponseAuBot) {
    if (texte) await ajouterMemoireGroupe(jid, texte);
    return;
  }
  
  if (commande) { await traiterCommande(jid, texte, message); return; }
  
  if (estMessageAudio(message)) {
    try {
      await envoyerTexte(jid, '🎧 J’écoute...');
      const audioBuffer = await telechargerMedia(message, 'audio');
      const transcription = await transcrireAudio(audioBuffer);
      const reponse = await genererIA(transcription, obtenirConversationId(message));
      await envoyerReponseVocale(jid, reponse, message);
    } catch { await envoyerReponse(jid, '❌ Erreur traitement vocal.'); }
    return;
  }
  
  if (texte) {
    const conversationId = obtenirConversationId(message);
    const memoireGroupe = groupe ? await lireMemoireGroupe(jid) : [];
    let question = texte;
    if (memoireGroupe.length) question += '\n\nContexte mémorisé :\n' + memoireGroupe.slice(-8).map(i => `- ${i.text}`).join('\n');
    const reponse = await genererIA(question, conversationId);
    if (groupe) await ajouterMemoireGroupe(jid, texte);
    await envoyerReponse(jid, reponse, message);
  }
}

async function envoyerAuGroupe(texte) {
  if (!WHATSAPP_GROUP_ID || !sock || !whatsappConnected) return;
  try { await sock.sendMessage(WHATSAPP_GROUP_ID, { text: texte }); } catch {}
}

function configurerCron() {
  cron.schedule('30 6 * * *', async () => {
    try {
      const prompt = 'Génère une courte méditation biblique du matin. Un verset exact, explication simple, encouragement. Max 5 lignes.';
      const medit = await genererIA(prompt, 'meditation-matin');
      await envoyerAuGroupe('🌅 *MÉDITATION DU MATIN* 🙏\n\n' + medit + '\n\nExcellente journée ! ✨');
    } catch {}
  }, { timezone: TIME_ZONE });
  
  cron.schedule('0 17 * * 0', async () => {
    const rapport = await getCotisationsReport();
    await envoyerAuGroupe('📢 *BILAN DES COTISATIONS DU DIMANCHE* 🪙\n\n' + rapport);
  }, { timezone: TIME_ZONE });
  
  console.log('✅ Crons configurés.');
}

async function connectToWhatsApp() {
  if (connexionEnCours) return;
  connexionEnCours = true;
  const generation = ++connectionGeneration;
  try {
    const { state, saveCreds } = await useFirebaseAuthState();
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: [BOT_NAME, 'Chrome', '1.0.0'] });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      if (generation !== connectionGeneration) return;
      const { connection, qr } = update;
      if (qr) { qrDataURL = await QRCode.toDataURL(qr); console.log('📱 QR prêt.'); }
      if (connection === 'open') { whatsappConnected = true; qrDataURL = null; console.log(`✅ ${BOT_NAME} connecté.`); }
      if (connection === 'close') { whatsappConnected = false; setTimeout(() => connectToWhatsApp(), 5000); }
    });
    sock.ev.on('messages.upsert', async event => {
      if (generation !== connectionGeneration || event.type !== 'notify') return;
      for (const message of event.messages || []) traiterMessage(message).catch(()=>{});
    });
  } catch { setTimeout(() => connectToWhatsApp(), 10000); } finally { connexionEnCours = false; }
}

const app = express();
app.get('/', (req, res) => {
  if (whatsappConnected) return res.send(`<h2>✅ ${BOT_NAME} connecté !</h2><p>Créateur : ${CREATOR_NAME}</p>`);
  if (!qrDataURL) return res.send(`<h2>⏳ Chargement QR... rafraîchis</h2>`);
  res.send(`<h2>Scanne ce QR :</h2><img src="${qrDataURL}" style="width:280px"/>`);
});
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: whatsappConnected, time: obtenirDateAbidjan() }));

async function demarrer() {
  app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Serveur ${BOT_NAME} sur ${PORT}`));
  configurerCron();
  await connectToWhatsApp();
}
demarrer();
