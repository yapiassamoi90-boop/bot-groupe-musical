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

import {
  readFileSync,
  existsSync,
  promises as fs
} from 'fs';

import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

// ======================================================
// CONFIGURATION
// ======================================================

const PORT = Number(process.env.PORT || 10000);

const BOT_NAME = process.env.BOT_NAME || 'HBOT';

const CREATOR_NAME =
  process.env.CREATOR_NAME ||
  'Assamoi Yapi Hyppolite, informaticien développeur';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const GROQ_MODEL =
  process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  'meta-llama/llama-4-scout-17b-16e-instruct';

const WHISPER_MODEL =
  process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';

const VOICE_REPLY_ENABLED =
  String(process.env.VOICE_REPLY_ENABLED ?? 'true').toLowerCase()
  === 'true';

const WHATSAPP_GROUP_ID =
  process.env.WHATSAPP_GROUP_ID ||
  '22567647800-1546850208@g.us';

const MAX_HISTORY = 12;
const MAX_CONVERSATIONS = 500;
const MAX_GROUP_MEMORY = 120;

const MAX_AUDIO_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

const AUTH_DIR = process.env.AUTH_DIR || './auth_info';

const TIME_ZONE = 'Africa/Abidjan';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const app = express();

app.use(express.json({ limit: '1mb' }));

// ======================================================
// ÉTAT DU BOT
// ======================================================

let sock = null;
let latestQR = null;
let qrDataURL = null;

let whatsappConnected = false;
let connexionEnCours = false;

let connectionGeneration = 0;
let reconnectTimer = null;

const conversations = new Map();
const processingMessages = new Set();

// Liste officielle des membres du groupe
const LISTE_OFFICIELLE_MEMBRES = [
  "Joanna", "Armand", "Sea Franck", "Koulate jean Christ", 
  "Samuel", "Issouph", "Nancy", "Marina", "Berenice", 
  "Lili", "Mbro", "Diby", "Anne", "Mme Assamoi", "Mme Diallo", "Evodie", "Marie Ange"
];

// ======================================================
// GROQ
// ======================================================

let groq = null;

if (GROQ_API_KEY) {
  groq = new Groq({
    apiKey: GROQ_API_KEY
  });

  console.log('✅ Clé Groq configurée.');
} else {
  console.warn('⚠️ GROQ_API_KEY absente.');
}

// ======================================================
// FIREBASE
// ======================================================

let db = null;

try {
  if (!admin.apps.length) {
    const candidates = [
      '/etc/secrets/serviceAccountKey.json',
      './serviceAccountKey.json'
    ];

    const serviceAccountPath = candidates.find(
      file => existsSync(file)
    );

    if (serviceAccountPath) {
      const serviceAccount = JSON.parse(
        readFileSync(serviceAccountPath, 'utf8')
      );

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });

      console.log('✅ Firebase initialisé.');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      );

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });

      console.log('✅ Firebase initialisé avec la variable d’environnement.');
    } else {
      console.warn(
        '⚠️ Fichier de compte Firebase introuvable. Les cotisations seront indisponibles.'
      );
    }
  }

  if (admin.apps.length) {
    db = admin.firestore();
  }
} catch (error) {
  console.error('❌ Erreur Firebase :', error.message);
}

// ======================================================
// GESTION PERSISTANTE DES CREDENTIALS DANS FIREBASE
// ======================================================

async function useFirebaseAuthState() {
  const baseDir = AUTH_DIR;
  if (!existsSync(baseDir)) {
    await fs.mkdir(baseDir, { recursive: true });
  }

  const readData = async (file) => {
    try {
      if (db) {
        const docRef = db.collection('whatsapp_auth').doc(file.replace(/[/\\.]/g, '_'));
        const doc = await docRef.get();
        if (doc.exists && doc.data()?.content) {
          return JSON.parse(doc.data().content, (k, v) => {
            if (v !== null && typeof v === 'object' && v.type === 'Buffer') {
              return Buffer.from(v.data);
            }
            return v;
          });
        }
      }
      const filePath = path.join(baseDir, file);
      if (existsSync(filePath)) {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      }
    } catch (e) {
      console.error(`Erreur lecture auth ${file}:`, e.message);
    }
    return null;
  };

  const writeData = async (data, file) => {
    try {
      const filePath = path.join(baseDir, file);
      const stringified = JSON.stringify(data, (k, v) => (v instanceof Buffer ? { type: 'Buffer', data: Array.from(v) } : v));
      await fs.writeFile(filePath, stringified, 'utf8');

      if (db) {
        const docRef = db.collection('whatsapp_auth').doc(file.replace(/[/\\.]/g, '_'));
        await docRef.set({ content: stringified, updatedAt: new Date() });
      }
    } catch (e) {
      console.error(`Erreur écriture auth ${file}:`, e.message);
    }
  };

  const creds = (await readData('creds.json')) || (await import('@whiskeysockets/baileys')).initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}.json`);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : fs.unlink(path.join(AUTH_DIR, file)).catch(() => {}));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds.json')
  };
}

// ======================================================
// IDENTITÉ ET INSTRUCTIONS DE L’IA
// ======================================================

const SYSTEM_PROMPT = `
Tu es ${BOT_NAME}, un assistant WhatsApp intelligent,
chaleureux, cultivé, bienveillant et naturel.

Tu as été créé et développé par ${CREATOR_NAME}.

IDENTITÉ :
- Si quelqu'un demande qui tu es, présente-toi comme ${BOT_NAME}.
- Si quelqu'un demande qui t'a créé, réponds :
  « Je suis ${BOT_NAME}, créé et développé par ${CREATOR_NAME}. »
- Tu es une intelligence artificielle, pas un être humain.
- N'invente jamais des informations personnelles sur ton créateur.

STYLE :
- Réponds principalement en français simple et naturel.
- Sois chaleureux, poli, parfois humoristique.
- Adapte la longueur de ta réponse à la question.
- Évite les réponses trop longues lorsque ce n'est pas nécessaire.
- Utilise les emojis avec modération.
- Ne suppose jamais le sexe de la personne qui t'écrit.
- Si un message contient des fautes, comprends son intention sans la ridiculiser.
`;

// ======================================================
// OUTILS GÉNÉRAUX
// ======================================================

function nettoyerTexte(texte = '') {
  return String(texte)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function obtenirDateAbidjan(date = new Date()) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function obtenirMessageReel(message) {
  let contenu = message?.message;

  while (contenu) {
    if (contenu.ephemeralMessage?.message) {
      contenu = contenu.ephemeralMessage.message;
      continue;
    }

    if (contenu.viewOnceMessage?.message) {
      contenu = contenu.viewOnceMessage.message;
      continue;
    }

    if (contenu.viewOnceMessageV2?.message) {
      contenu = contenu.viewOnceMessageV2.message;
      continue;
    }

    break;
  }

  return contenu || {};
}

function obtenirTexteMessage(message) {
  const contenu = obtenirMessageReel(message);

  return (
    contenu.conversation ||
    contenu.extendedTextMessage?.text ||
    contenu.imageMessage?.caption ||
    contenu.videoMessage?.caption ||
    contenu.documentMessage?.caption ||
    ''
  ).trim();
}

function estCommande(texte = '') {
  return /^!(aide|help|id|resetia|programme|cotisation|cotisations|c|setprogramme|retard|impayes)\b/i
    .test(texte.trim());
}

function extraireJidParticipant(message) {
  return message?.key?.participant || message?.participant || '';
}

function estMessageDeMoi(message) {
  return message?.key?.fromMe === true;
}

function estMessageDeGroupe(message) {
  return String(message?.key?.remoteJid || '').endsWith('@g.us');
}

function obtenirConversationId(message) {
  const jid = message?.key?.remoteJid || '';
  const participant = extraireJidParticipant(message);
  return estMessageDeGroupe(message) ? `${jid}:${participant}` : jid;
}

function obtenirNomExpediteur(message) {
  return message?.pushName || message?.verifiedBizName || 'Ami';
}

function obtenirJid(message) {
  return message?.key?.remoteJid || '';
}

function estMessageAudio(message) {
  const contenu = obtenirMessageReel(message);
  return Boolean(contenu.audioMessage || contenu.pttMessage);
}

// ======================================================
// HISTORIQUE ET IA
// ======================================================

function obtenirHistorique(conversationId) {
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, []);
  }
  return conversations.get(conversationId);
}

function ajouterHistorique(conversationId, role, content) {
  const historique = obtenirHistorique(conversationId);
  historique.push({ role, content });
  while (historique.length > MAX_HISTORY * 2) historique.shift();
}

function reinitialiserHistorique(conversationId) {
  conversations.delete(conversationId);
}

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
  } catch (error) {
    return 'Je rencontre un problème technique.';
  }
}

// ======================================================
// ENVOI DE MESSAGES & MÉDIAS
// ======================================================

async function envoyerTexte(jid, texte, options = {}) {
  if (!sock || !whatsappConnected) return false;
  try {
    await sock.sendMessage(jid, { text: String(texte), ...options });
    return true;
  } catch (error) {
    return false;
  }
}

async function envoyerReponse(jid, texte, messageOriginal = null) {
  if (!sock || !whatsappConnected) return false;
  try {
    const options = messageOriginal?.key ? { quoted: messageOriginal } : {};
    await sock.sendMessage(jid, { text: texte, ...options });
    return true;
  } catch (error) {
    return false;
  }
}

async function telechargerMedia(message, type) {
  const contenu = obtenirMessageReel(message);
  const media = type === 'audio' ? (contenu.audioMessage || contenu.pttMessage) : contenu.imageMessage;
  if (!media) throw new Error('Média introuvable.');
  const stream = await downloadContentFromMessage(media, type);
  const morceaux = [];
  for await (const morceau of stream) morceaux.push(morceau);
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
  } finally {
    await fs.rm(dossier, { recursive: true, force: true });
  }
}

async function envoyerReponseVocale(jid, texte, messageOriginal = null) {
  if (!VOICE_REPLY_ENABLED) return envoyerReponse(jid, texte, messageOriginal);
  try {
    const mp3 = await genererAudioElevenLabs(texte);
    const ogg = await convertirMp3EnOgg(mp3);
    const options = { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    if (messageOriginal?.key) options.quoted = messageOriginal;
    await sock.sendMessage(jid, options);
    return true;
  } catch (e) {
    return envoyerReponse(jid, texte, messageOriginal);
  }
}

// ======================================================
// GESTION DES COTISATIONS (CUMUL PAR MEMBRE, JOANNA EN 1er)
// ======================================================

function obtenirNomTransaction(data) {
  return String(data.name || data.memberName || data.nom || 'Membre').trim();
}

function obtenirMontantTransaction(data) {
  return Number(data.amount || data.montant || 0);
}

function formaterMontant(montant) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(montant);
}

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
        if (nomBrut.length > nomExactJoanna.length) {
          nomExactJoanna = nomBrut;
        }
      } else {
        totauxParMembre[nomBrut] = (totauxParMembre[nomBrut] || 0) + montant;
      }
    });

    const autres = Object.keys(totauxParMembre).map(nom => ({
      nom,
      total: totauxParMembre[nom]
    }));
    autres.sort((a, b) => b.total - a.total);

    const classement = [];
    if (joannaTotal > 0) {
      classement.push({ nom: nomExactJoanna, total: joannaTotal });
    }
    classement.push(...autres);

    const lignes = classement.map((item, index) => {
      const symbole = index === 0 ? '🥇' : '✅';
      return `${symbole} *${item.nom}* : *${formaterMontant(item.total)} FCFA*`;
    });

    return [
      '📊 *TOTAL DES COTISATIONS PAR MEMBRE* 🪙',
      '',
      ...lignes,
      '',
      '💡 Merci pour votre fidélité ! 🙏✨'
    ].join('\n');
  } catch (error) {
    return '❌ Erreur récupération cotisations.';
  }
}

async function getImpayesReport() {
  if (!db) return '⚠️ Firebase indisponible.';
  try {
    const snapshot = await db.collection('transactions').limit(100).get();
    const payeursSet = new Set();
    snapshot.docs.forEach(doc => payeursSet.add(obtenirNomTransaction(doc.data()).toLowerCase().trim()));

    const impayes = LISTE_OFFICIELLE_MEMBRES.filter(m => !payeursSet.has(m.toLowerCase().trim()));
    if (impayes.length === 0) return '🎉 Tout le monde a payé sa cotisation !';

    return ['⏳ *PERSONNES EN RETARD (IMPAYÉS)* ⚠️', '', impayes.map(m => `❌ *${m}*`).join('\n'), '', `Total : ${impayes.length} personne(s)`].join('\n');
  } catch (e) {
    return '❌ Erreur rapport retards.';
  }
}

// ======================================================
// PROGRAMME DE L'ÉGLISE
// ======================================================

let texteProgrammeMois = `⛪ *ÉGLISE DES ASSEMBLÉES DE DIEU ABOBO BELLEVILLE - TEMPLE LA RESTAURATION DIVINE*

📅 *PROGRAMME DES MOIS DE NOVEMBRE ET DÉCEMBRE (GROUPE MUSICAL)*

🔴 *NOVEMBRE*
• *01/11/26* : Adoration: Anne | Célébration: Nancy | 1ère & 2e Offrande: Mme Diby
• *08/11/26* : Adoration: Joanne | Célébration: Mme M'Bro | 1ère & 2e Offrande: Mme Diallo
• *15/11/26* : Adoration: Nancy | Célébration: Anne | 1ère & 2e Offrande: Marie-Ange
• *22/11/26* : Adoration: Berenice | Célébration: Mme Diallo | 1ère & 2e Offrande: Joanne
• *29/11/26* : Adoration: Mme M'Bro | Célébration: Marie Ange | 1ère & 2e Offrande: Nancy

🟢 *DÉCEMBRE*
• *06/12/26* : Adoration: Mme Diallo | Célébration: Berenice | 1ère & 2e Offrande: Anne
• *13/12/26* : Adoration: Nancy | Célébration: Joanne | 1ère & 2e Offrande: Mme M'Bro
• *20/12/26* : Adoration: Marie Ange | Célébration: Mme Diallo | 1ère & 2e Offrande: Berenice
• *27/12/26* : Adoration: Joanne | Célébration: Anne | 1ère & 2e Offrande: Mme Diby`;

// ======================================================
// COMMANDES ET TRAITEMENT DES MESSAGES
// ======================================================

async function traiterCommande(jid, texte, message) {
  const commande = texte.trim().split(/\s+/)[0].toLowerCase();
  switch (commande) {
    case '!aide':
    case '!help':
      await envoyerReponse(jid, `🤖 *COMMANDES*\n!id, !resetia, !programme, !cotisation, !retard`, message);
      return true;
    case '!id':
      await envoyerReponse(jid, `🆔 ID : ${jid}`, message);
      return true;
    case '!resetia':
      reinitialiserHistorique(obtenirConversationId(message));
      await envoyerReponse(jid, '🧠 Mémoire réinitialisée !', message);
      return true;
    case '!programme':
      await envoyerReponse(jid, texteProgrammeMois, message);
      return true;
    case '!cotisation':
    case '!cotisations':
    case '!c':
      await envoyerReponse(jid, await getCotisationsReport(), message);
      return true;
    case '!retard':
    case '!impayes':
      await envoyerReponse(jid, await getImpayesReport(), message);
      return true;
    default:
      return false;
  }
}

async function traiterMessage(message) {
  if (!message?.message || estMessageDeMoi(message)) return;
  const jid = obtenirJid(message);
  if (!jid || jid === 'status@broadcast') return;

  const texte = obtenirTexteMessage(message);
  if (estCommande(texte)) {
    await traiterCommande(jid, texte, message);
    return;
  }

  if (estMessageAudio(message)) {
    try {
      await envoyerTexte(jid, '🎧 J’écoute...');
      const audioBuffer = await telechargerMedia(message, 'audio');
      const transcription = await transcrireAudio(audioBuffer);
      const reponse = await genererIA(transcription, obtenirConversationId(message));
      await envoyerReponseVocale(jid, reponse, message);
    } catch (e) {
      await envoyerReponse(jid, '❌ Erreur traitement vocal.');
    }
    return;
  }

  if (texte) {
    const reponse = await genererIA(texte, obtenirConversationId(message));
    await envoyerReponse(jid, reponse, message);
  }
}

// ======================================================
// CONNEXION WHATSAPP AVEC PERSISTENCE FIREBASE
// ======================================================

async function connectToWhatsApp() {
  if (connexionEnCours) return;
  connexionEnCours = true;
  const generation = ++connectionGeneration;

  try {
    const { state, saveCreds } = await useFirebaseAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: [BOT_NAME, 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      if (generation !== connectionGeneration) return;
      const { connection, qr } = update;

      if (qr) {
        qrDataURL = await QRCode.toDataURL(qr);
        console.log('📱 Nouveau QR code disponible.');
      }
      if (connection === 'open') {
        whatsappConnected = true;
        qrDataURL = null;
        console.log(`✅ ${BOT_NAME} connecté à WhatsApp.`);
      }
      if (connection === 'close') {
        whatsappConnected = false;
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    });

    sock.ev.on('messages.upsert', async event => {
      if (generation !== connectionGeneration || event.type !== 'notify') return;
      for (const message of event.messages || []) {
        traiterMessage(message).catch(() => {});
      }
    });
  } catch (error) {
    setTimeout(() => connectToWhatsApp(), 10000);
  } finally {
    connexionEnCours = false;
  }
}

// ======================================================
// SERVEUR WEB
// ======================================================

const appServer = express();
appServer.get('/', (req, res) => {
  if (whatsappConnected) {
    return res.send(`<h2>✅ ${BOT_NAME} est connecté à WhatsApp ! Plus besoin de scanner.</h2>`);
  }
  if (!qrDataURL) {
    return res.send(`<h2>⏳ Chargement du QR code... Rafraîchis la page.</h2>`);
  }
  res.send(`<h2>Scanne ce QR code :</h2><img src="${qrDataURL}"/>`);
});

appServer.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: whatsappConnected }));

async function demarrer() {
  appServer.listen(PORT, '0.0.0.0', () => console.log(`Serveur sur le port ${PORT}`));
  await connectToWhatsApp();
}

demarrer();
