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

const PORT = Number(process.env.PORT || 3000);

const BOT_NAME = process.env.BOT_NAME || 'Hbot1';
const CREATOR_NAME =
  process.env.CREATOR_NAME || 'Assamoi Yapi Hyppolite';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL =
  process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  'meta-llama/llama-4-scout-17b-16e-instruct';

const WHISPER_MODEL =
  process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';

const WHISPER_LANGUAGE =
  process.env.WHISPER_LANGUAGE || 'fr';

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || '';

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || '';

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

const VOICE_REPLY_ENABLED =
  (process.env.VOICE_REPLY_ENABLED || 'true').toLowerCase() ===
  'true';

const WHATSAPP_GROUP_ID =
  process.env.WHATSAPP_GROUP_ID ||
  '22567647800-1546850208@g.us';

const MAX_HISTORY = 12;
const MAX_CONVERSATIONS = 500;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const AUTH_FOLDER = './auth_info_baileys';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const groq = GROQ_API_KEY
  ? new Groq({ apiKey: GROQ_API_KEY })
  : null;

// ======================================================
// ÉTAT DU BOT
// ======================================================

let currentQrImage = null;
let isConnected = false;
let sockInstance = null;
let connectionGeneration = 0;
let connexionEnCours = false;

const conversationHistory = new Map();
const processingMessages = new Set();

// ======================================================
// FIREBASE
// ======================================================

let db = null;

try {
  if (!admin.apps.length) {
    const cheminsPossibles = [
      '/etc/secrets/serviceAccountKey.json',
      './serviceAccountKey.json'
    ];

    let serviceAccount = null;

    for (const fichier of cheminsPossibles) {
      if (existsSync(fichier)) {
        serviceAccount = JSON.parse(
          readFileSync(fichier, 'utf8')
        );
        break;
      }
    }

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });

      db = admin.firestore();
      logger.info('Firebase initialisé.');
    } else {
      logger.warn(
        'Firebase non configuré : fichier serviceAccountKey.json introuvable.'
      );
    }
  } else {
    db = admin.firestore();
  }
} catch (error) {
  logger.error(
    { error: error.message },
    'Erreur initialisation Firebase.'
  );
}

// ======================================================
// PROMPT PRINCIPAL
// ======================================================

const SYSTEM_PROMPT = `
Tu es ${BOT_NAME}, un assistant WhatsApp intelligent, chaleureux,
cultivé, serviable, bienveillant et parfois drôle.

IDENTITÉ :
- Tu es ${BOT_NAME}.
- Tu as été créé et développé par ${CREATOR_NAME}.
- Si on te demande qui t'a créé, réponds clairement :
  "Je suis ${BOT_NAME}, créé et développé par ${CREATOR_NAME}."
- Tu ne prétends jamais être un être humain.

LANGUE ET STYLE :
- Réponds principalement en français simple et naturel.
- Adapte la longueur de ta réponse à la question.
- Sois naturel, comme un grand frère proche des jeunes,
  sans supposer le genre de la personne.
- Évite les réponses trop longues, répétitives ou robotiques.
- Utilise les emojis avec modération.
- Si le message contient des fautes, comprends l'intention sans
  critiquer la personne.

DOMAINES :
- Aide scolaire et explications générales.
- Technologie, programmation et informatique.
- Vie quotidienne, conseils et organisation.
- Explications bibliques lorsque cela est demandé.
- Église des Assemblées de Dieu - Temple de la Restauration Divine.

FIABILITÉ :
- N'invente pas des faits, des dates, des montants ou des résultats.
- Si tu ne connais pas une information, dis-le honnêtement.
- Pour les informations récentes, utilise la recherche Internet
  lorsqu'elle est disponible.
- Ne prétends jamais avoir envoyé un message ou effectué une action
  que tu n'as pas réellement effectuée.

MESSAGES VOCAUX :
- Réponds directement au contenu du message transcrit.
- Ne dis pas inutilement "selon votre transcription".

GROUPES WHATSAPP :
- Sois respectueux des membres.
- Réponds à la question réellement posée.
`;

// ======================================================
// HISTORIQUE DES CONVERSATIONS
// ======================================================

function getHistory(chatId) {
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }

  return conversationHistory.get(chatId);
}

function resetHistory(chatId) {
  conversationHistory.delete(chatId);
}

function limiterHistorique() {
  while (conversationHistory.size > MAX_CONVERSATIONS) {
    const premiereCle = conversationHistory.keys().next().value;

    if (premiereCle === undefined) break;

    conversationHistory.delete(premiereCle);
  }
}

// ======================================================
// UTILITAIRES
// ======================================================

function normaliserTexte(texte = '') {
  return String(texte)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function nettoyerTexteVocal(texte = '') {
  return String(texte)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[*_~>#]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

function estCommandeDirecte(texte = '') {
  return String(texte).trim().startsWith('!');
}

function extraireNumeroJid(jid = '') {
  return jid.split('@')[0].split(':')[0];
}

function estJidGroupe(jid = '') {
  return jid.endsWith('@g.us');
}

function nettoyerMention(texte = '') {
  return String(texte)
    .replace(/@\d+/g, '')
    .trim();
}

// ======================================================
// IDENTIFIANT DU BOT
// ======================================================

function obtenirJidBot() {
  return sockInstance?.user?.id || '';
}

function estMentionBot(message, texte = '') {
  const botJid = obtenirJidBot();

  if (!botJid) return false;

  const contexte =
    message?.message?.extendedTextMessage?.contextInfo ||
    message?.message?.imageMessage?.contextInfo ||
    message?.message?.videoMessage?.contextInfo ||
    message?.message?.documentMessage?.contextInfo ||
    {};

  const mentions = contexte.mentionedJid || [];

  const botNumero = extraireNumeroJid(botJid);

  const mentionDirecte = mentions.some(
    jid => extraireNumeroJid(jid) === botNumero
  );

  const texteNormalise = normaliserTexte(texte);
  const nomNormalise = normaliserTexte(BOT_NAME);

  const nomDansTexte = new RegExp(
    `(^|\\s)${nomNormalise.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,:!?]|$)`,
    'i'
  ).test(texteNormalise);

  return mentionDirecte || nomDansTexte;
}

// ======================================================
// APPEL DE GROQ
// ======================================================

async function genererIA(chatId, texte, options = {}) {
  if (!groq) {
    return 'Désolé, mon service d’intelligence artificielle n’est pas configuré. Réessaie plus tard.';
  }

  const historique = getHistory(chatId);

  const messages = [
    {
      role: 'system',
      content: SYSTEM_PROMPT
    },
    ...historique,
    {
      role: 'user',
      content: String(texte).slice(0, 12000)
    }
  ];

  try {
    const reponse = await groq.chat.completions.create({
      model: options.vision ? GROQ_VISION_MODEL : GROQ_MODEL,
      messages,
      temperature: 0.7,
      max_completion_tokens: 1200
    });

    const contenu =
      reponse.choices?.[0]?.message?.content;

    const texteReponse =
      typeof contenu === 'string' && contenu.trim()
        ? contenu.trim()
        : 'Je n’ai pas réussi à préparer une réponse. Peux-tu reformuler ?';

    historique.push(
      {
        role: 'user',
        content: String(texte).slice(0, 12000)
      },
      {
        role: 'assistant',
        content: texteReponse
      }
    );

    while (historique.length > MAX_HISTORY * 2) {
      historique.shift();
    }

    limiterHistorique();

    return texteReponse;
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur Groq.'
    );

    return 'Je rencontre un petit problème pour réfléchir à ta question. Réessaie dans un instant.';
  }
}
// ======================================================
// TÉLÉCHARGEMENT DES MÉDIAS WHATSAPP
// ======================================================

async function telechargerMedia(mediaMessage, type = 'image') {
  const limites = {
    image: MAX_IMAGE_BYTES,
    video: MAX_VIDEO_BYTES,
    audio: MAX_AUDIO_BYTES
  };

  const limite = limites[type] || MAX_IMAGE_BYTES;

  const flux = await downloadContentFromMessage(
    mediaMessage,
    type
  );

  const morceaux = [];
  let taille = 0;

  for await (const morceau of flux) {
    taille += morceau.length;

    if (taille > limite) {
      throw new Error(
        `Le média dépasse la limite autorisée de ${Math.round(limite / 1024 / 1024)} Mo.`
      );
    }

    morceaux.push(morceau);
  }

  return Buffer.concat(morceaux);
}

// ======================================================
// TRANSCRIPTION AUDIO AVEC GROQ WHISPER
// ======================================================

async function transcrireAudio(
  buffer,
  filename = 'audio.ogg',
  mimetype = 'audio/ogg'
) {
  if (!groq) {
    throw new Error('Groq n’est pas configuré.');
  }

  const fichier = await toFile(
    buffer,
    filename,
    { type: mimetype }
  );

  const resultat = await groq.audio.transcriptions.create({
    file: fichier,
    model: WHISPER_MODEL,
    language: WHISPER_LANGUAGE,
    response_format: 'text'
  });

  if (typeof resultat === 'string') {
    return resultat.trim();
  }

  return String(resultat?.text || '').trim();
}

// ======================================================
// GÉNÉRATION VOCALE ELEVENLABS
// ======================================================

async function genererAudioElevenLabs(texte) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error(
      'ELEVENLABS_API_KEY ou ELEVENLABS_VOICE_ID manquant.'
    );
  }

  const reponse = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: nettoyerTexteVocal(texte),
        model_id: ELEVENLABS_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  );

  if (!reponse.ok) {
    const erreur = await reponse.text();

    throw new Error(
      `ElevenLabs ${reponse.status}: ${erreur.slice(0, 300)}`
    );
  }

  return Buffer.from(await reponse.arrayBuffer());
}

// ======================================================
// CONVERSION MP3 EN OGG OPUS AVEC FFMPEG
// ======================================================

async function convertirMp3EnOgg(mp3Buffer) {
  if (!ffmpegPath) {
    throw new Error('FFmpeg n’est pas disponible.');
  }

  const dossierTemp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hbot1-')
  );

  const fichierMp3 = path.join(dossierTemp, 'audio.mp3');
  const fichierOgg = path.join(dossierTemp, 'audio.ogg');

  try {
    await fs.writeFile(fichierMp3, mp3Buffer);

    await new Promise((resolve, reject) => {
      const processus = spawn(ffmpegPath, [
        '-y',
        '-i', fichierMp3,
        '-vn',
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-application', 'voip',
        fichierOgg
      ]);

      let erreur = '';

      processus.stderr.on('data', donnees => {
        erreur += donnees.toString();
      });

      processus.on('error', reject);

      processus.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`Erreur FFmpeg (${code}): ${erreur.slice(-500)}`)
          );
        }
      });
    });

    return await fs.readFile(fichierOgg);
  } finally {
    await fs.rm(dossierTemp, {
      recursive: true,
      force: true
    });
  }
}

// ======================================================
// ENVOI D'UNE RÉPONSE VOCALE
// ======================================================

async function envoyerVocal(sock, jid, texte) {
  if (!VOICE_REPLY_ENABLED) return false;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    return false;
  }

  try {
    const texteNettoye = nettoyerTexteVocal(texte);

    if (!texteNettoye) return false;

    const mp3 = await genererAudioElevenLabs(texteNettoye);
    const ogg = await convertirMp3EnOgg(mp3);

    await sock.sendMessage(jid, {
      audio: ogg,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    });

    return true;
  } catch (error) {
    logger.error(
      { error: error.message },
      'Échec de l’envoi vocal.'
    );

    return false;
  }
}

// ======================================================
// EXTRACTION DES IMAGES D'UNE VIDÉO
// ======================================================

async function extraireImagesVideo(buffer) {
  if (!ffmpegPath) {
    throw new Error('FFmpeg n’est pas disponible.');
  }

  const dossierTemp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hbot1-video-')
  );

  const fichierVideo = path.join(dossierTemp, 'video.mp4');

  try {
    await fs.writeFile(fichierVideo, buffer);

    const duree = await new Promise((resolve, reject) => {
      const processus = spawn(ffmpegPath, [
        '-i', fichierVideo,
        '-hide_banner'
      ]);

      let sortie = '';

      processus.stderr.on('data', data => {
        sortie += data.toString();
      });

      processus.on('error', reject);

      processus.on('close', () => {
        const match = sortie.match(
          /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
        );

        if (!match) {
          reject(new Error('Durée de la vidéo inconnue.'));
          return;
        }

        resolve(
          Number(match[1]) * 3600 +
          Number(match[2]) * 60 +
          Number(match[3])
        );
      });
    });

    const positions = duree < 3
      ? [Math.max(0, duree / 2)]
      : [
          duree * 0.15,
          duree * 0.50,
          duree * 0.85
        ];

    const images = [];

    for (let i = 0; i < positions.length; i++) {
      const fichierImage = path.join(
        dossierTemp,
        `image-${i}.jpg`
      );

      await new Promise((resolve, reject) => {
        const processus = spawn(ffmpegPath, [
          '-y',
          '-ss', String(positions[i]),
          '-i', fichierVideo,
          '-frames:v', '1',
          '-vf', 'scale=768:-1',
          '-q:v', '5',
          fichierImage
        ]);

        let erreur = '';

        processus.stderr.on('data', data => {
          erreur += data.toString();
        });

        processus.on('error', reject);

        processus.on('close', code => {
          if (code === 0) resolve();
          else reject(
            new Error(`Extraction image impossible: ${erreur.slice(-300)}`)
          );
        });
      });

      images.push(await fs.readFile(fichierImage));
    }

    return images;
  } finally {
    await fs.rm(dossierTemp, {
      recursive: true,
      force: true
    });
  }
}

// ======================================================
// ANALYSE D'UNE IMAGE
// ======================================================

async function analyserImage(buffer, question = '') {
  if (!groq) {
    return 'L’analyse des images n’est pas disponible actuellement.';
  }

  const imageBase64 = buffer.toString('base64');

  const message = [
    {
      type: 'text',
      text: question ||
        'Décris cette image avec précision, en français simple.'
    },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${imageBase64}`
      }
    }
  ];

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
          content: message
        }
      ],
      max_completion_tokens: 1000
    });

    return resultat.choices?.[0]?.message?.content ||
      'Je n’ai pas réussi à analyser cette image.';
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur analyse image.'
    );

    return 'Je n’arrive pas à analyser cette image pour le moment. Vérifie que le modèle de vision configuré est disponible sur Groq.';
  }
}

// ======================================================
// ANALYSE D'UNE VIDÉO
// ======================================================

async function analyserVideo(buffer, question = '') {
  try {
    const images = await extraireImagesVideo(buffer);

    if (!images.length) {
      return 'Je n’ai pas pu extraire les images de cette vidéo.';
    }

    const imagesBase64 = images.map(image => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${image.toString('base64')}`
      }
    }));

    const contenu = [
      {
        type: 'text',
        text: question ||
          'Décris cette vidéo à partir des images fournies. Précise que ton analyse porte sur quelques images extraites.'
      },
      ...imagesBase64
    ];

    const resultat = await groq.chat.completions.create({
      model: GROQ_VISION_MODEL,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: contenu
        }
      ],
      max_completion_tokens: 1200
    });

    return resultat.choices?.[0]?.message?.content ||
      'Je n’ai pas réussi à analyser cette vidéo.';
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur analyse vidéo.'
    );

    return 'Je n’ai pas réussi à analyser cette vidéo. Vérifie le format et la disponibilité du modèle de vision.';
  }
}
