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

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || '';

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || '';

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

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

CONTEXTE :
Tu peux aider avec les études, la technologie, la culture générale,
la vie quotidienne, les explications bibliques et les questions pratiques.

ÉGLISE :
Lorsque c'est pertinent, réponds avec respect aux questions bibliques.
Ne prétends pas connaître des informations qui ne t'ont pas été données.
N'invente pas les horaires, les décisions ou les événements de l'église.

FIABILITÉ :
- Si tu ne connais pas une information, dis-le honnêtement.
- Ne prétends pas avoir effectué une recherche Internet si ce n'est pas le cas.
- Ne prétends pas avoir envoyé un fichier ou réalisé une action que tu n'as pas effectuée.
- Respecte toujours la question posée.
`;

// ======================================================
// OUTILS GÉNÉRAUX
// ======================================================

function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

    if (contenu.documentWithCaptionMessage?.message) {
      contenu = contenu.documentWithCaptionMessage.message;
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
    contenu.buttonsResponseMessage?.selectedDisplayText ||
    contenu.listResponseMessage?.title ||
    contenu.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim();
}

function estCommande(texte = '') {
  return /^!(aide|help|id|resetia|programme|cotisation|cotisations|c|setprogramme)\b/i
    .test(texte.trim());
}

function extraireJidParticipant(message) {
  return (
    message?.key?.participant ||
    message?.participant ||
    ''
  );
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

  return estMessageDeGroupe(message)
    ? `${jid}:${participant}`
    : jid;
}

function obtenirNomExpediteur(message) {
  return (
    message?.pushName ||
    message?.verifiedBizName ||
    'Ami'
  );
}

function obtenirJid(message) {
  return message?.key?.remoteJid || '';
}

function estMentionBot(message, texte = '') {
  const contenu = obtenirMessageReel(message);

  const mentions =
    contenu.extendedTextMessage?.contextInfo?.mentionedJid ||
    contenu.imageMessage?.contextInfo?.mentionedJid ||
    contenu.videoMessage?.contextInfo?.mentionedJid ||
    [];

  if (
    mentions.some(jid =>
      String(jid).includes('status')
    )
  ) {
    return true;
  }

  const monJid = sock?.user?.id || '';
  const monNumero = monJid.split(':')[0].split('@')[0];

  const texteNormalise = texte.toLowerCase();

  if (
    monNumero &&
    texteNormalise.includes(monNumero)
  ) {
    return true;
  }

  return /\b(hbot|bot)\b/i.test(texte);
}

function estReponseAuBot(message) {
  const contenu = obtenirMessageReel(message);

  const contextInfo =
    contenu.extendedTextMessage?.contextInfo ||
    contenu.imageMessage?.contextInfo ||
    contenu.videoMessage?.contextInfo ||
    contenu.audioMessage?.contextInfo;

  const stanzaId = contextInfo?.stanzaId;

  if (!stanzaId) {
    return false;
  }

  return contextInfo?.participant === sock?.user?.id ||
    contextInfo?.participant?.startsWith(
      sock?.user?.id?.split(':')[0] || '###'
    );
}

function estMessageAudio(message) {
  const contenu = obtenirMessageReel(message);

  return Boolean(
    contenu.audioMessage ||
    contenu.pttMessage
  );
}

function estMessageImage(message) {
  const contenu = obtenirMessageReel(message);

  return Boolean(contenu.imageMessage);
}

function estMessageVideo(message) {
  const contenu = obtenirMessageReel(message);

  return Boolean(contenu.videoMessage);
}

// ======================================================
// MÉMOIRE DES CONVERSATIONS
// ======================================================

function obtenirHistorique(conversationId) {
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, []);
  }

  return conversations.get(conversationId);
}

function ajouterHistorique(conversationId, role, content) {
  const historique = obtenirHistorique(conversationId);

  historique.push({
    role,
    content
  });

  while (historique.length > MAX_HISTORY * 2) {
    historique.shift();
  }

  if (conversations.size > MAX_CONVERSATIONS) {
    const premiereCle = conversations.keys().next().value;

    if (premiereCle) {
      conversations.delete(premiereCle);
    }
  }
}

function reinitialiserHistorique(conversationId) {
  conversations.delete(conversationId);
}

// ======================================================
// RÉPONSE IA GROQ
// ======================================================

async function genererIA(texte, conversationId, options = {}) {
  if (!groq) {
    return 'Désolé, mon service d’intelligence artificielle n’est pas configuré pour le moment.';
  }

  const historique = obtenirHistorique(conversationId);

  const messages = [
    {
      role: 'system',
      content: SYSTEM_PROMPT
    },
    ...historique,
    {
      role: 'user',
      content: texte
    }
  ];

  try {
    const reponse = await groq.chat.completions.create({
      model: options.model || GROQ_MODEL,
      messages,
      max_completion_tokens: 1200
    });

    const resultat = nettoyerTexte(
      reponse.choices?.[0]?.message?.content || ''
    );

    if (!resultat) {
      return 'Je n’ai pas réussi à formuler une réponse. Peux-tu reformuler ta question ?';
    }

    ajouterHistorique(conversationId, 'user', texte);
    ajouterHistorique(conversationId, 'assistant', resultat);

    return resultat;
  } catch (error) {
    console.error('❌ Erreur Groq :', error.message);

    return 'Je rencontre actuellement un problème pour répondre. Réessaie dans un instant.';
  }
}

// ======================================================
// ENVOI DE MESSAGES WHATSAPP
// ======================================================

async function envoyerTexte(jid, texte, options = {}) {
  if (!sock || !whatsappConnected) {
    console.warn('⚠️ Envoi impossible : WhatsApp non connecté.');
    return false;
  }

  try {
    await sock.sendMessage(jid, {
      text: String(texte),
      ...options
    });

    return true;
  } catch (error) {
    console.error('❌ Erreur envoi WhatsApp :', error.message);
    return false;
  }
}

async function envoyerReponse(jid, texte, messageOriginal = null) {
  if (!sock || !whatsappConnected) {
    return false;
  }

  try {
    const options = {};

    if (messageOriginal?.key) {
      options.quoted = messageOriginal;
    }

    await sock.sendMessage(jid, {
      text: texte,
      ...options
    });

    return true;
  } catch (error) {
    console.error('❌ Erreur réponse :', error.message);
    return false;
  }
}

// ======================================================
// TÉLÉCHARGEMENT DES MÉDIAS
// ======================================================

async function telechargerMedia(message, type) {
  const contenu = obtenirMessageReel(message);

  let media;

  if (type === 'audio') {
    media = contenu.audioMessage || contenu.pttMessage;
  } else if (type === 'image') {
    media = contenu.imageMessage;
  } else if (type === 'video') {
    media = contenu.videoMessage;
  }

  if (!media) {
    throw new Error(`Média ${type} introuvable.`);
  }

  const stream = await downloadContentFromMessage(media, type);

  const morceaux = [];
  let taille = 0;

  const limite =
    type === 'audio'
      ? MAX_AUDIO_SIZE
      : MAX_IMAGE_SIZE;

  for await (const morceau of stream) {
    taille += morceau.length;

    if (taille > limite) {
      throw new Error('Le fichier est trop volumineux.');
    }

    morceaux.push(morceau);
  }

  return Buffer.concat(morceaux);
}

// ======================================================
// TRANSCRIPTION AUDIO AVEC WHISPER
// ======================================================

async function transcrireAudio(buffer) {
  if (!groq) {
    throw new Error('Groq n’est pas configuré.');
  }

  const fichier = await toFile(
    buffer,
    'message.ogg',
    {
      type: 'audio/ogg'
    }
  );

  const resultat = await groq.audio.transcriptions.create({
    file: fichier,
    model: WHISPER_MODEL,
    language: 'fr',
    response_format: 'text'
  });

  const texte = typeof resultat === 'string'
    ? resultat
    : resultat.text || '';

  if (!texte.trim()) {
    throw new Error('Aucune parole détectée dans le message audio.');
  }

  return texte.trim();
}

// ======================================================
// ELEVENLABS : SYNTHÈSE VOCALE
// ======================================================

function nettoyerTextePourVoix(texte) {
  return String(texte)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

async function genererAudioElevenLabs(texte) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error(
      'ELEVENLABS_API_KEY ou ELEVENLABS_VOICE_ID manquante.'
    );
  }

  const texteVoix = nettoyerTextePourVoix(texte);

  if (!texteVoix) {
    throw new Error('Aucun texte à convertir en audio.');
  }

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`;

  const reponse = await fetch(
    `${url}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: texteVoix,
        model_id: ELEVENLABS_MODEL,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75
        }
      })
    }
  );

  if (!reponse.ok) {
    const details = await reponse.text();

    throw new Error(
      `ElevenLabs HTTP ${reponse.status}: ${details.slice(0, 300)}`
    );
  }

  return Buffer.from(await reponse.arrayBuffer());
}

// ======================================================
// CONVERSION MP3 VERS OGG/OPUS POUR WHATSAPP
// ======================================================

async function convertirMp3EnOgg(mp3Buffer) {
  if (!ffmpegPath) {
    throw new Error('FFmpeg n’est pas disponible.');
  }

  const dossier = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hbot-audio-')
  );

  const mp3Path = path.join(dossier, 'input.mp3');
  const oggPath = path.join(dossier, 'output.ogg');

  try {
    await fs.writeFile(mp3Path, mp3Buffer);

    await new Promise((resolve, reject) => {
      const processus = spawn(ffmpegPath, [
        '-y',
        '-i', mp3Path,
        '-vn',
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-f', 'ogg',
        oggPath
      ]);

      let stderr = '';

      processus.stderr.on('data', data => {
        stderr += data.toString();
      });

      processus.on('error', reject);

      processus.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`Conversion audio échouée : ${stderr.slice(-500)}`)
          );
        }
      });
    });

    return await fs.readFile(oggPath);
  } finally {
    await fs.rm(dossier, {
      recursive: true,
      force: true
    });
  }
}

// ======================================================
// RÉPONSE VOCALE
// ======================================================

async function envoyerReponseVocale(jid, texte, messageOriginal = null) {
  if (!VOICE_REPLY_ENABLED) {
    return envoyerReponse(jid, texte, messageOriginal);
  }

  try {
    const mp3 = await genererAudioElevenLabs(texte);
    const ogg = await convertirMp3EnOgg(mp3);

    if (!sock || !whatsappConnected) {
      return false;
    }

    const options = {
      audio: ogg,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    };

    if (messageOriginal?.key) {
      options.quoted = messageOriginal;
    }

    await sock.sendMessage(jid, options);

    return true;
  } catch (error) {
    console.error('❌ Réponse vocale impossible :', error.message);

    // Si la synthèse vocale échoue, le bot répond quand même par écrit.
    return envoyerReponse(jid, texte, messageOriginal);
  }
}

// ======================================================
// ANALYSE D'IMAGE AVEC GROQ VISION
// ======================================================

async function analyserImage(buffer, question = '') {
  if (!groq) {
    return 'Le service d’analyse d’image n’est pas configuré.';
  }

  const base64 = buffer.toString('base64');

  const prompt = question.trim()
    ? `Analyse cette image et réponds à la question suivante : ${question}`
    : 'Décris cette image avec précision en français.';

  try {
    const resultat = await groq.chat.completions.create({
      model: GROQ_VISION_MODEL,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64}`
              }
            }
          ]
        }
      ],
      max_completion_tokens: 1000
    });

    return nettoyerTexte(
      resultat.choices?.[0]?.message?.content ||
      'Je n’ai pas réussi à analyser cette image.'
    );
  } catch (error) {
    console.error('❌ Erreur analyse image :', error.message);

    return 'Je n’arrive pas à analyser cette image pour le moment. Vérifie que le modèle de vision configuré est disponible avec ta clé Groq.';
  }
}

// ======================================================
// MÉMOIRE DE GROUPE FIRESTORE
// ======================================================

function encoderJid(jid) {
  return Buffer.from(jid).toString('base64url');
}

async function ajouterMemoireGroupe(jid, texte) {
  if (!db || !jid || !texte) {
    return;
  }

  const motsCles =
    /cotisation|cotisations|fcfa|prix|date|heure|lieu|sortie|voyage|réunion|reunion|décision|decision|programme/i;

  if (!motsCles.test(texte)) {
    return;
  }

  try {
    const reference = db
      .collection('hbot2_group_memory')
      .doc(encoderJid(jid));

    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);

      const anciennesMemoires = snapshot.exists
        ? snapshot.data().items || []
        : [];

      const nouvelleMemoire = {
        text: texte.slice(0, 1000),
        date: new Date().toISOString()
      };

      const items = [
        ...anciennesMemoires,
        nouvelleMemoire
      ].slice(-MAX_GROUP_MEMORY);

      transaction.set(reference, {
        jid,
        items,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (error) {
    console.error('⚠️ Mémoire groupe :', error.message);
  }
}

async function lireMemoireGroupe(jid) {
  if (!db || !jid) {
    return [];
  }

  try {
    const snapshot = await db
      .collection('hbot2_group_memory')
      .doc(encoderJid(jid))
      .get();

    if (!snapshot.exists) {
      return [];
    }

    return snapshot.data().items || [];
  } catch (error) {
    console.error('⚠️ Lecture mémoire groupe :', error.message);
    return [];
  }
}

// ======================================================
// COTISATIONS FIREBASE
// ======================================================

function convertirDateCotisation(valeur) {
  if (!valeur) {
    return null;
  }

  if (typeof valeur.toDate === 'function') {
    return valeur.toDate();
  }

  if (valeur instanceof Date) {
    return valeur;
  }

  if (typeof valeur === 'number') {
    return new Date(
      valeur < 1e12 ? valeur * 1000 : valeur
    );
  }

  if (typeof valeur === 'string') {
    const date = new Date(valeur);

    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  if (typeof valeur === 'object' && valeur.seconds) {
    return new Date(valeur.seconds * 1000);
  }

  return null;
}

function obtenirDateTransaction(data) {
  const champsDate = [
    'timestamp',
    'date',
    'createdAt',
    'created_at',
    'createdOn',
    'dateCreation',
    'date_cotisation'
  ];

  for (const champ of champsDate) {
    if (data[champ] !== undefined && data[champ] !== null) {
      const date = convertirDateCotisation(data[champ]);

      if (date && !Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }

  return null;
}

function obtenirNomTransaction(data) {
  const champs = [
    'name',
    'memberName',
    'nom',
    'member',
    'membre'
  ];

  for (const champ of champs) {
    if (data[champ] !== undefined && data[champ] !== null) {
      const nom = String(data[champ]).trim();

      if (nom) {
        return nom;
      }
    }
  }

  return 'Membre non identifié';
}

function obtenirMontantTransaction(data) {
  const champs = [
    'amount',
    'montant',
    'amountFCFA',
    'montantFCFA'
  ];

  for (const champ of champs) {
    if (data[champ] !== undefined && data[champ] !== null) {
      const montant = Number(data[champ]);

      if (Number.isFinite(montant)) {
        return montant;
      }
    }
  }

  return 0;
}

function formaterMontant(montant) {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 0
  }).format(montant);
}

function formaterDateCotisation(date) {
  if (!date) {
    return 'date inconnue';
  }

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

async function getCotisationsReport() {
  if (!db) {
    return '⚠️ Le service Firebase est indisponible. Vérifie le compte de service et la connexion à Firestore.';
  }

  try {
    const snapshot = await db
      .collection('transactions')
      .limit(100)
      .get();

    if (snapshot.empty) {
      return [
        '📊 *CLASSEMENT DES COTISATIONS* 🪙',
        '',
        'Aucune cotisation enregistrée pour le moment.',
        '',
        '💡 Merci pour votre fidélité ! 🙏✨'
      ].join('\n');
    }

    const transactions = snapshot.docs.map(doc => {
      const data = doc.data();

      return {
        id: doc.id,
        nom: obtenirNomTransaction(data),
        montant: obtenirMontantTransaction(data),
        date: obtenirDateTransaction(data)
      };
    });

    // Les plus anciennes cotisations apparaissent en premier.
    transactions.sort((a, b) => {
      const dateA = a.date?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const dateB = b.date?.getTime() ?? Number.MAX_SAFE_INTEGER;

      return dateA - dateB;
    });

    const lignes = transactions.map((transaction, index) => {
      const symbole = index === 0 ? '🥇' : '✅';

      const date = formaterDateCotisation(transaction.date);

      const montant = formaterMontant(transaction.montant);

      return `${symbole} *${transaction.nom}* : +${montant} FCFA _(${date})_`;
    });

    return [
      '📊 *CLASSEMENT DES COTISATIONS* 🪙',
      '',
      ...lignes,
      '',
      '💡 Merci pour votre fidélité ! 🙏✨'
    ].join('\n');
  } catch (error) {
    console.error('❌ Erreur rapport cotisations :', error.message);

    return '❌ Impossible de récupérer les cotisations pour le moment. Vérifie la collection transactions dans Firebase.';
  }
}

// ======================================================
// PROGRAMME DE L'ÉGLISE
// ======================================================

function obtenirJourAbidjan(date = new Date()) {
  const jour = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'long'
  }).format(date);

  return jour.toLowerCase();
}

function obtenirDateLocaleAbidjan(date = new Date()) {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const valeurs = Object.fromEntries(
    parties.map(partie => [partie.type, partie.value])
  );

  return `${valeurs.year}-${valeurs.month}-${valeurs.day}`;
}

function obtenirProgrammeDuDimanche() {
  const maintenant = new Date();

  const dateLocale = obtenirDateLocaleAbidjan(maintenant);

  const jour = obtenirJourAbidjan(maintenant);

  const decalages = {
    monday: 6,
    tuesday: 5,
    wednesday: 4,
    thursday: 3,
    friday: 2,
    saturday: 1,
    sunday: 0
  };

  const decalage = decalages[jour] ?? 0;

  const dateDimanche = new Date(
    `${dateLocale}T12:00:00Z`
  );

  dateDimanche.setUTCDate(
    dateDimanche.getUTCDate() + decalage
  );

  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(dateDimanche);
}

let programmePersonnalise = '';

function obtenirProgramme() {
  if (programmePersonnalise) {
    return programmePersonnalise;
  }

  return [
    '📅 *PROGRAMME DE L’ÉGLISE*',
    '',
    '🙏 Pour connaître les horaires précis des cultes,',
    'merci de consulter les responsables de l’église.',
    '',
    '📌 Prochaine date dominicale :',
    obtenirProgrammeDuDimanche()
  ].join('\n');
}

// ======================================================
// COMMANDES
// ======================================================

async function traiterCommande(jid, texte, message) {
  const commande = texte.trim().split(/\s+/)[0].toLowerCase();

  switch (commande) {
    case '!aide':
    case '!help': {
      const aide = [
        `🤖 *COMMANDES DE ${BOT_NAME}*`,
        '',
        '🆔 `!id` — afficher l’identifiant du groupe',
        '🧠 `!resetia` — réinitialiser ma mémoire de conversation',
        '📅 `!programme` — afficher le programme',
        '🪙 `!cotisation` — afficher les cotisations',
        '🪙 `!cotisations` — afficher les cotisations',
        '🪙 `!c` — raccourci des cotisations',
        '📌 `!setprogramme texte` — définir le programme',
        '',
        'Tu peux aussi me mentionner pour me poser une question.'
      ].join('\n');

      await envoyerReponse(jid, aide, message);
      return true;
    }

    case '!id': {
      await envoyerReponse(
        jid,
        `🆔 Identifiant de cette conversation :\n${jid}`,
        message
      );

      return true;
    }

    case '!resetia': {
      const conversationId = obtenirConversationId(message);

      reinitialiserHistorique(conversationId);

      await envoyerReponse(
        jid,
        '🧠 C’est fait ! Je repars sur une nouvelle conversation avec toi.',
        message
      );

      return true;
    }

    case '!programme': {
      await envoyerReponse(jid, obtenirProgramme(), message);
      return true;
    }

    case '!cotisation':
    case '!cotisations':
    case '!c': {
      const rapport = await getCotisationsReport();

      await envoyerReponse(jid, rapport, message);
      return true;
    }

    case '!setprogramme': {
      const nouveauProgramme = texte
        .replace(/^!setprogramme\s*/i, '')
        .trim();

      if (!nouveauProgramme) {
        await envoyerReponse(
          jid,
          'Utilisation : !setprogramme suivi du texte du programme.',
          message
        );

        return true;
      }

      programmePersonnalise = nouveauProgramme;

      await envoyerReponse(
        jid,
        '✅ Programme personnalisé mis à jour en mémoire.',
        message
      );

      return true;
    }

    default:
      return false;
  }
}

// ======================================================
// TRAITEMENT DES MESSAGES
// ======================================================

async function traiterMessage(message) {
  if (!message?.message || estMessageDeMoi(message)) {
    return;
  }

  const jid = obtenirJid(message);

  if (!jid || jid === 'status@broadcast') {
    return;
  }

  const messageId = message.key?.id;

  if (!messageId || processingMessages.has(messageId)) {
    return;
  }

  processingMessages.add(messageId);

  try {
    const texte = obtenirTexteMessage(message);

    const groupe = estMessageDeGroupe(message);

    const commande = estCommande(texte);

    const mention = estMentionBot(message, texte);

    const reponseAuBot = estReponseAuBot(message);

    // En groupe, HBOT ne répond qu'aux commandes,
    // aux mentions et aux réponses qui lui sont adressées.
    if (groupe && !commande && !mention && !reponseAuBot) {
      await ajouterMemoireGroupe(jid, texte);
      return;
    }

    const nom = obtenirNomExpediteur(message);

    console.log(
      `📩 Message de ${nom} dans ${jid} : ${texte.slice(0, 150)}`
    );

    // Les commandes sont traitées avant l'IA.
    if (commande) {
      await traiterCommande(jid, texte, message);
      return;
    }

    const contenu = obtenirMessageReel(message);

    // --------------------------------------------------
    // IMAGE
    // --------------------------------------------------

    if (contenu.imageMessage) {
      await envoyerTexte(jid, '👀 Je regarde ton image...');

      try {
        const imageBuffer = await telechargerMedia(message, 'image');

        const question = texte ||
          contenu.imageMessage.caption ||
          'Décris cette image.';

        const analyse = await analyserImage(imageBuffer, question);

        await envoyerReponse(jid, analyse, message);
      } catch (error) {
        console.error('❌ Traitement image :', error.message);

        await envoyerReponse(
          jid,
          'Je n’ai pas pu traiter cette image. Essaie avec une image plus légère.',
          message
        );
      }

      return;
    }

    // --------------------------------------------------
    // AUDIO / MESSAGE VOCAL
    // --------------------------------------------------

    if (estMessageAudio(message)) {
      try {
        await envoyerTexte(jid, '🎧 J’écoute ton message vocal...');

        const audioBuffer = await telechargerMedia(message, 'audio');

        const transcription = await transcrireAudio(audioBuffer);

        console.log('🗣️ Transcription obtenue.');

        const conversationId = obtenirConversationId(message);

        const memoireGroupe = groupe
          ? await lireMemoireGroupe(jid)
          : [];

        const contexteMemoire = memoireGroupe.length
          ? '\n\nInformations précédemment retenues pour ce groupe :\n' +
            memoireGroupe
              .slice(-10)
              .map(item => `- ${item.text}`)
              .join('\n')
          : '';

        const question = contexteMemoire
          ? `${transcription}${contexteMemoire}`
          : transcription;

        const reponse = await genererIA(
          question,
          conversationId
        );

        await ajouterMemoireGroupe(jid, transcription);

        if (VOICE_REPLY_ENABLED) {
          await envoyerReponseVocale(jid, reponse, message);
        } else {
          await envoyerReponse(jid, reponse, message);
        }
      } catch (error) {
        console.error('❌ Traitement vocal :', error.message);

        await envoyerReponse(
          jid,
          'Désolé, je n’ai pas réussi à traiter ton message vocal. Vérifie la configuration de Whisper et réessaie.',
          message
        );
      }

      return;
    }

    // --------------------------------------------------
    // VIDÉO
    // --------------------------------------------------

    if (contenu.videoMessage) {
      await envoyerReponse(
        jid,
        '🎥 J’ai reçu ta vidéo. Pour l’instant, je peux t’aider à partir de sa description ou de son texte. Décris-moi ce que tu souhaites analyser.',
        message
      );

      return;
    }

    // --------------------------------------------------
    // MESSAGE TEXTE
    // --------------------------------------------------

    if (!texte) {
      return;
    }

    // Présentation explicite du bot et de son créateur.
    if (
      /\b(qui es[- ]tu|qui est[- ]tu|qui t['’]a créé|qui ta créé|ton créateur|ton createur|qui t['’]a développé|qui ta developpe)\b/i
        .test(texte)
    ) {
      await envoyerReponse(
        jid,
        `Je suis ${BOT_NAME}, créé et développé par ${CREATOR_NAME}. 😊`,
        message
      );

      return;
    }

    const conversationId = obtenirConversationId(message);

    const memoireGroupe = groupe
      ? await lireMemoireGroupe(jid)
      : [];

    let question = texte;

    if (memoireGroupe.length) {
      const contexte = memoireGroupe
        .slice(-8)
        .map(item => `- ${item.text}`)
        .join('\n');

      question +=
        '\n\nContexte mémorisé pour ce groupe (à utiliser seulement si pertinent) :\n' +
        contexte;
    }

    const reponse = await genererIA(
      question,
      conversationId
    );

    await ajouterMemoireGroupe(jid, texte);

    await envoyerReponse(jid, reponse, message);
  } catch (error) {
    console.error('❌ Erreur traitement message :', error);

    await envoyerReponse(
      obtenirJid(message),
      'Désolé, une erreur est survenue. Réessaie dans un instant.',
      message
    );
  } finally {
    processingMessages.delete(message.key?.id);
  }
}

// ======================================================
// RAPPELS ET MESSAGES PROGRAMMÉS
// ======================================================

async function envoyerAuGroupe(texte) {
  if (!WHATSAPP_GROUP_ID) {
    return;
  }

  await envoyerTexte(WHATSAPP_GROUP_ID, texte);
}

function configurerCron() {
  // Méditation quotidienne à 06 h 30.
  cron.schedule(
    '30 6 * * *',
    async () => {
      await envoyerAuGroupe(
        '🌅 *BONJOUR À TOUS !* 🙏\n\n' +
        'Que cette nouvelle journée soit remplie de paix, de sagesse et de courage.\n\n' +
        'Prenons un moment pour prier, méditer et confier nos activités à Dieu. ✨'
      );
    },
    { timezone: TIME_ZONE }
  );

  // Veillée le premier et le dernier vendredi du mois.
  cron.schedule(
    '0 14 * * 5',
    async () => {
      const maintenant = new Date();

      const jourDuMois = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: TIME_ZONE,
          day: 'numeric'
        }).format(maintenant)
      );

      const dernierJour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: TIME_ZONE,
          day: 'numeric'
        }).format(
          new Date(
            Date.UTC(
              Number(
                new Intl.DateTimeFormat('en-US', {
                  timeZone: TIME_ZONE,
                  year: 'numeric'
                }).format(maintenant)
              ),
              Number(
                new Intl.DateTimeFormat('en-US', {
                  timeZone: TIME_ZONE,
                  month: 'numeric'
                }).format(maintenant)
              ),
              0
            )
          )
        )
      );

      const dernierVendredi = dernierJour - (
        new Date(
          Date.UTC(
            maintenant.getUTCFullYear(),
            maintenant.getUTCMonth(),
            dernierJour
          )
        ).getUTCDay() === 5
          ? 0
          : 0
      );

      const premierVendredi = jourDuMois <= 7;

      // On détermine le dernier vendredi à partir du calendrier local.
      const mois = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: TIME_ZONE,
          month: 'numeric'
        }).format(maintenant)
      );

      const annee = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: TIME_ZONE,
          year: 'numeric'
        }).format(maintenant)
      );

      const dernierJourDuMois = new Date(
        Date.UTC(annee, mois, 0)
      ).getUTCDate();

      let dernierVendrediDuMois = dernierJourDuMois;

      while (
        new Date(
          Date.UTC(annee, mois - 1, dernierVendrediDuMois)
        ).getUTCDay() !== 5
      ) {
        dernierVendrediDuMois--;
      }

      const estDernierVendredi =
        jourDuMois === dernierVendrediDuMois;

      if (premierVendredi || estDernierVendredi) {
        await envoyerAuGroupe(
          '🙏 *INFORMATION : VEILLÉE DE PRIÈRE*\n\n' +
          'Que chacun se prépare dans la prière et reste attentif aux informations communiquées par les responsables de l’église. ✨'
        );
      }
    },
    { timezone: TIME_ZONE }
  );

  // Programme du week-end : vendredi et samedi à 14 h.
  cron.schedule(
    '0 14 * * 5,6',
    async () => {
      await envoyerAuGroupe(
        '📅 *PROGRAMME DU WEEK-END*\n\n' +
        'Préparons-nous pour les activités de l’église. 🙏\n\n' +
        'Pour les horaires et les détails exacts, veuillez vous référer aux responsables.'
      );
    },
    { timezone: TIME_ZONE }
  );

  // Rappel cotisation le samedi à 16 h.
  cron.schedule(
    '0 16 * * 6',
    async () => {
      await envoyerAuGroupe(
        '🪙 *RAPPEL DES COTISATIONS*\n\n' +
        'N’oublions pas notre participation pour les activités prévues. Merci à chacun pour son engagement et sa fidélité. 🙏'
      );
    },
    { timezone: TIME_ZONE }
  );

  // Rappel le dimanche à 11 h 30.
  cron.schedule(
    '30 11 * * 0',
    async () => {
      await envoyerAuGroupe(
        '🙏 *BON DIMANCHE À TOUS !*\n\n' +
        'Que Dieu nous accompagne en cette journée. Restons attentifs aux informations relatives au programme de l’église. ✨'
      );
    },
    { timezone: TIME_ZONE }
  );

  // Rapport des cotisations le dimanche à 17 h.
  cron.schedule(
    '0 17 * * 0',
    async () => {
      const rapport = await getCotisationsReport();

      await envoyerAuGroupe(rapport);
    },
    { timezone: TIME_ZONE }
  );

  // Message du dimanche à 20 h.
  cron.schedule(
    '0 20 * * 0',
    async () => {
      await envoyerAuGroupe(
        '🌙 *BONNE SOIRÉE À TOUS !*\n\n' +
        'Que cette soirée soit paisible. Prenons soin les uns des autres et préparons la nouvelle semaine avec confiance. 🙏✨'
      );
    },
    { timezone: TIME_ZONE }
  );

  console.log('✅ Tâches programmées configurées.');
}

// ======================================================
// CONNEXION WHATSAPP
// ======================================================

async function connectToWhatsApp() {
  if (connexionEnCours) {
    console.log('⏳ Connexion déjà en cours.');
    return;
  }

  connexionEnCours = true;

  const generation = ++connectionGeneration;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(
      AUTH_DIR
    );

    const versionInfo = await fetchLatestBaileysVersion();

    const version = versionInfo.version;

    console.log('📦 Version WhatsApp :', version.join('.'));

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: [BOT_NAME, 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      if (generation !== connectionGeneration) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;

        try {
          qrDataURL = await QRCode.toDataURL(qr);
          console.log('📱 Nouveau QR code disponible.');
        } catch (error) {
          console.error('❌ Génération QR :', error.message);
        }
      }

      if (connection === 'connecting') {
        console.log('🔄 Connexion à WhatsApp...');
      }

      if (connection === 'open') {
        whatsappConnected = true;
        latestQR = null;
        qrDataURL = null;

        console.log(`✅ ${BOT_NAME} est connecté à WhatsApp.`);
      }

      if (connection === 'close') {
        whatsappConnected = false;

        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : lastDisconnect?.error?.output?.statusCode;

        console.error(
          '❌ Connexion fermée. Code :',
          statusCode ?? 'inconnu'
        );

        if (statusCode === DisconnectReason.loggedOut) {
          console.error(
            '🚫 Session déconnectée. Il faut supprimer l’ancienne session et rescanner le QR code.'
          );

          return;
        }

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }

        reconnectTimer = setTimeout(() => {
          if (
            generation === connectionGeneration &&
            !whatsappConnected
          ) {
            console.log('🔄 Tentative de reconnexion...');

            connectToWhatsApp().catch(error => {
              console.error(
                '❌ Reconnexion échouée :',
                error.message
              );
            });
          }
        }, 5000);
      }
    });

    sock.ev.on('messages.upsert', async event => {
      if (generation !== connectionGeneration) {
        return;
      }

      if (event.type !== 'notify') {
        return;
      }

      for (const message of event.messages || []) {
        traiterMessage(message).catch(error => {
          console.error(
            '❌ Erreur message WhatsApp :',
            error.message
          );
        });
      }
    });
  } catch (error) {
    console.error(
      '❌ Impossible de connecter WhatsApp :',
      error.message
    );

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      connectToWhatsApp().catch(console.error);
    }, 10000);
  } finally {
    connexionEnCours = false;
  }
}

// ======================================================
// SERVEUR WEB : QR CODE ET ÉTAT DU BOT
// ======================================================

app.get('/', async (req, res) => {
  if (whatsappConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="15">
        <title>${BOT_NAME}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #101820;
            color: white;
            text-align: center;
            padding: 30px 15px;
          }
          .card {
            max-width: 500px;
            margin: 40px auto;
            padding: 25px;
            border-radius: 15px;
            background: #1d2b36;
          }
          .ok {
            color: #52e3a3;
            font-size: 22px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 ${BOT_NAME}</h1>
          <p class="ok">✅ WhatsApp connecté</p>
          <p>Le bot est opérationnel.</p>
          <p>Créateur : ${CREATOR_NAME}</p>
          <p>Actualisation automatique toutes les 15 secondes.</p>
        </div>
      </body>
      </html>
    `);
  }

  if (!qrDataURL) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="5">
        <title>${BOT_NAME}</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:30px">
        <h1>🤖 ${BOT_NAME}</h1>
        <p>⏳ En attente du QR code WhatsApp...</p>
        <p>Cette page s'actualise automatiquement.</p>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="15">
      <title>Connexion ${BOT_NAME}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          text-align: center;
          background: #101820;
          color: white;
          padding: 25px 10px;
        }
        .card {
          max-width: 450px;
          margin: auto;
          padding: 25px;
          background: #1d2b36;
          border-radius: 15px;
        }
        img {
          width: 260px;
          max-width: 90%;
          background: white;
          padding: 10px;
          border-radius: 10px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🤖 ${BOT_NAME}</h1>
        <p>📱 Scanne ce QR code avec WhatsApp.</p>
        <img src="${qrDataURL}" alt="QR code WhatsApp">
        <p>WhatsApp → Appareils connectés → Connecter un appareil.</p>
        <p>Cette page s'actualise automatiquement.</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    bot: BOT_NAME,
    whatsapp: whatsappConnected,
    groq: Boolean(groq),
    whisper: Boolean(groq),
    elevenlabs: Boolean(
      ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID
    ),
    voiceReplyEnabled: VOICE_REPLY_ENABLED,
    firebase: Boolean(db),
    webSearch: Boolean(process.env.TAVILY_API_KEY),
    groupMemory: Boolean(db),
    time: obtenirDateAbidjan()
  });
});

// ======================================================
// DÉMARRAGE DU SERVEUR
// ======================================================

async function demarrer() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur ${BOT_NAME} actif sur le port ${PORT}.`);
  });

  configurerCron();

  await connectToWhatsApp();
}

demarrer().catch(error => {
  console.error('❌ Erreur démarrage :', error);

  process.exitCode = 1;
});
