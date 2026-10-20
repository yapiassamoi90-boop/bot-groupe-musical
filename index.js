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
// FIN DE LA PARTIE 1
// ======================================================
