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
// ======================================================
// EXTRACTION DES MESSAGES WHATSAPP
// ======================================================

function obtenirMessageReel(message) {
  let contenu = message?.message;

  if (!contenu) return null;

  for (let i = 0; i < 5; i++) {
    if (contenu.ephemeralMessage?.message) {
      contenu = contenu.ephemeralMessage.message;
    } else if (contenu.viewOnceMessage?.message) {
      contenu = contenu.viewOnceMessage.message;
    } else if (contenu.viewOnceMessageV2?.message) {
      contenu = contenu.viewOnceMessageV2.message;
    } else if (contenu.viewOnceMessageV2Extension?.message) {
      contenu = contenu.viewOnceMessageV2Extension.message;
    } else {
      break;
    }
  }

  return contenu;
}

function extraireTexteMessage(message) {
  const contenu = obtenirMessageReel(message);

  if (!contenu) return '';

  return (
    contenu.conversation ||
    contenu.extendedTextMessage?.text ||
    contenu.imageMessage?.caption ||
    contenu.videoMessage?.caption ||
    contenu.documentMessage?.caption ||
    contenu.buttonsResponseMessage?.selectedButtonId ||
    contenu.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  ).trim();
}

function extraireContexte(message) {
  const contenu = obtenirMessageReel(message);

  return (
    contenu?.extendedTextMessage?.contextInfo ||
    contenu?.imageMessage?.contextInfo ||
    contenu?.videoMessage?.contextInfo ||
    contenu?.audioMessage?.contextInfo ||
    contenu?.documentMessage?.contextInfo ||
    {}
  );
}

function extraireMedia(message) {
  const contenu = obtenirMessageReel(message);

  if (!contenu) return null;

  if (contenu.imageMessage) {
    return {
      type: 'image',
      message: contenu.imageMessage
    };
  }

  if (contenu.videoMessage) {
    return {
      type: 'video',
      message: contenu.videoMessage
    };
  }

  if (contenu.audioMessage) {
    return {
      type: 'audio',
      message: contenu.audioMessage
    };
  }

  return null;
}

function reponseAuBot(message) {
  const contexte = extraireContexte(message);
  const botJid = obtenirJidBot();

  if (!contexte?.participant || !botJid) return false;

  return (
    extraireNumeroJid(contexte.participant) ===
    extraireNumeroJid(botJid)
  );
}

function creerCleConversation(jid, expediteur) {
  if (estJidGroupe(jid)) {
    return `${jid}:${expediteur}`;
  }

  return jid;
}

// ======================================================
// PROGRAMME DE L'ÉGLISE
// ======================================================

function texteProgrammeMois() {
  return [
    '📅 *PROGRAMME DE L’ÉGLISE*',
    '',
    'Église des Assemblées de Dieu',
    'Temple de la Restauration Divine',
    '',
    'Pour obtenir les dates exactes des activités du mois, consulte les annonces officielles de l’église.',
    '',
    '⚠️ Je ne veux pas inventer de dates ou d’horaires qui n’ont pas été confirmés.'
  ].join('\n');
}

function obtenirDateAbidjan(date = new Date()) {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Abidjan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const valeur = type =>
    parties.find(partie => partie.type === type)?.value;

  return {
    annee: Number(valeur('year')),
    mois: Number(valeur('month')),
    jour: Number(valeur('day'))
  };
}

function getProgrammeDuDimanche() {
  const maintenant = new Date();
  const dateAbidjan = obtenirDateAbidjan(maintenant);

  const dateLocale = new Date(Date.UTC(
    dateAbidjan.annee,
    dateAbidjan.mois - 1,
    dateAbidjan.jour
  ));

  const jourSemaine = dateLocale.getUTCDay();
  const joursJusquaDimanche = (7 - jourSemaine) % 7;

  dateLocale.setUTCDate(
    dateLocale.getUTCDate() + joursJusquaDimanche
  );

  const dateFormatee = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(dateLocale);

  return [
    '📅 *PROGRAMME DU DIMANCHE*',
    '',
    `Date : ${dateFormatee}`,
    '',
    'Pour les heures de culte et les activités précises, consulte les annonces officielles de l’église.',
    '',
    'Que Dieu vous bénisse ! 🙏'
  ].join('\n');
}

// ======================================================
// RAPPORT DES COTISATIONS FIREBASE
// ======================================================

async function getCotisationsReport() {
  if (!db) {
    return '⚠️ Firebase n’est pas configuré. Impossible de consulter les cotisations.';
  }

  try {
    const resultat = await db
      .collection('transactions')
      .limit(100)
      .get();

    if (resultat.empty) {
      return 'Aucune transaction de cotisation trouvée.';
    }

    const transactions = resultat.docs.map(doc => {
      const data = doc.data();

      return {
        nom: data.name || data.memberName || data.nom || 'Membre inconnu',
        montant: Number(
          data.amount ?? data.montant ?? 0
        ),
        date: data.date || data.createdAt || null
      };
    });

    transactions.sort((a, b) => {
      const aJoanna = normaliserTexte(a.nom).includes('joanna');
      const bJoanna = normaliserTexte(b.nom).includes('joanna');

      if (aJoanna && !bJoanna) return -1;
      if (!aJoanna && bJoanna) return 1;

      return a.nom.localeCompare(b.nom, 'fr');
    });

    const total = transactions.reduce(
      (somme, transaction) => somme + transaction.montant,
      0
    );

    const lignes = transactions.map(transaction =>
      `• ${transaction.nom} : ${transaction.montant.toLocaleString('fr-FR')} FCFA`
    );

    return [
      '📊 *RAPPORT DES COTISATIONS*',
      '',
      ...lignes,
      '',
      `*Total enregistré : ${total.toLocaleString('fr-FR')} FCFA*`,
      '',
      '⚠️ Ce rapport dépend des champs réellement enregistrés dans Firebase.'
    ].join('\n');
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur rapport cotisations.'
    );

    return 'Impossible de récupérer le rapport des cotisations pour le moment.';
  }
}

// ======================================================
// COMMANDES
// ======================================================

async function traiterCommande(texte, jid, sock, message, chatId) {
  const commande = normaliserTexte(texte).split(/\s+/)[0];

  switch (commande) {
    case '!aide':
    case '!help':
      return [
        '🤖 *COMMANDES DE HBOT1*',
        '',
        '!aide — Affiche les commandes',
        '!id — Affiche l’identifiant du groupe ou du chat',
        '!resetia — Réinitialise ton historique de conversation',
        '!programme — Affiche les informations du programme',
        '!cotisations — Affiche le rapport Firebase',
        '',
        'Tu peux aussi me poser directement tes questions.'
      ].join('\n');

    case '!id':
      return `🆔 Identifiant de ce chat :\n${jid}`;

    case '!resetia':
      resetHistory(chatId);
      return '✅ Ton historique de conversation a été réinitialisé.';

    case '!programme':
      return texteProgrammeMois() + '\n\n' + getProgrammeDuDimanche();

    case '!cotisations':
      return await getCotisationsReport();

    case '!setprogramme':
      return '⚠️ Cette commande ne modifie pas encore le programme. Les changements doivent être ajoutés explicitement au code ou à une source de données administrable.';

    default:
      return null;
  }
}

// ======================================================
// TRAITEMENT DES MESSAGES
// ======================================================

async function traiterMessages(sock, message) {
  const jid = message.key?.remoteJid;

  if (!jid || jid === 'status@broadcast') return;
  if (message.key?.fromMe) return;

  const expediteur =
    message.key?.participant ||
    jid;

  const cleMessage =
    message.key?.id
      ? `${jid}:${message.key.id}`
      : null;

  if (cleMessage && processingMessages.has(cleMessage)) {
    return;
  }

  if (cleMessage) {
    processingMessages.add(cleMessage);
  }

  try {
    const texteOriginal = extraireTexteMessage(message);
    const texteNormalise = normaliserTexte(texteOriginal);
    const groupe = estJidGroupe(jid);

    const mentionBot = estMentionBot(message, texteOriginal);
    const reponseBot = reponseAuBot(message);

    const commande = estCommandeDirecte(texteOriginal);

    // Dans un groupe, ne pas répondre à toutes les conversations.
    if (groupe && !mentionBot && !reponseBot && !commande) {
      return;
    }

    const chatId = creerCleConversation(jid, expediteur);

    // Commandes commençant par !
    if (commande) {
      const reponseCommande = await traiterCommande(
        texteOriginal,
        jid,
        sock,
        message,
        chatId
      );

      if (reponseCommande) {
        await sock.sendMessage(jid, {
          text: reponseCommande
        }, {
          quoted: message
        });

        return;
      }
    }

    // Réponse à une demande d'identité sans commande.
    if (
      texteNormalise === 'qui es tu' ||
      texteNormalise === 'qui est hbot1' ||
      texteNormalise === 'qui es hbot1' ||
      texteNormalise === 'qui t a cree' ||
      texteNormalise === 'qui est ton createur'
    ) {
      await sock.sendMessage(jid, {
        text: `Je suis ${BOT_NAME}, créé et développé par ${CREATOR_NAME}. 😊`
      }, {
        quoted: message
      });

      return;
    }

    const media = extraireMedia(message);

    // --------------------------------------------------
    // AUDIO / MESSAGE VOCAL
    // --------------------------------------------------

    if (media?.type === 'audio') {
      try {
        const buffer = await telechargerMedia(
          media.message,
          'audio'
        );

        const transcription = await transcrireAudio(
          buffer,
          media.message.mimetype?.includes('mpeg')
            ? 'audio.mp3'
            : 'audio.ogg',
          media.message.mimetype || 'audio/ogg'
        );

        if (!transcription) {
          await sock.sendMessage(jid, {
            text: 'Je n’ai pas réussi à comprendre ce message vocal. Peux-tu le renvoyer ?'
          }, {
            quoted: message
          });

          return;
        }

        const reponse = await genererIA(
          chatId,
          transcription
        );

        const vocalEnvoye = await envoyerVocal(
          sock,
          jid,
          reponse
        );

        if (!vocalEnvoye) {
          await sock.sendMessage(jid, {
            text: reponse
          }, {
            quoted: message
          });
        }

        return;
      } catch (error) {
        logger.error(
          { error: error.message },
          'Erreur traitement audio.'
        );

        await sock.sendMessage(jid, {
          text: 'Je n’arrive pas à traiter ce message vocal pour le moment. Réessaie avec un audio plus court.'
        }, {
          quoted: message
        });

        return;
      }
    }

    // --------------------------------------------------
    // IMAGE
    // --------------------------------------------------

    if (media?.type === 'image') {
      try {
        const buffer = await telechargerMedia(
          media.message,
          'image'
        );

        const question = texteOriginal ||
          'Décris cette image.';

        const reponse = await analyserImage(
          buffer,
          question
        );

        await sock.sendMessage(jid, {
          text: reponse
        }, {
          quoted: message
        });

        return;
      } catch (error) {
        logger.error(
          { error: error.message },
          'Erreur traitement image.'
        );

        await sock.sendMessage(jid, {
          text: 'Je n’arrive pas à lire cette image. Vérifie son format ou envoie une image plus légère.'
        }, {
          quoted: message
        });

        return;
      }
    }

    // --------------------------------------------------
    // VIDÉO
    // --------------------------------------------------

    if (media?.type === 'video') {
      try {
        const buffer = await telechargerMedia(
          media.message,
          'video'
        );

        const question = texteOriginal ||
          'Décris cette vidéo.';

        const reponse = await analyserVideo(
          buffer,
          question
        );

        await sock.sendMessage(jid, {
          text: reponse
        }, {
          quoted: message
        });

        return;
      } catch (error) {
        logger.error(
          { error: error.message },
          'Erreur traitement vidéo.'
        );

        await sock.sendMessage(jid, {
          text: 'Je n’arrive pas à analyser cette vidéo. Essaie avec une vidéo plus courte et plus légère.'
        }, {
          quoted: message
        });

        return;
      }
    }

    // --------------------------------------------------
    // TEXTE NORMAL
    // --------------------------------------------------

    let textePourIA = texteOriginal;

    if (groupe) {
      textePourIA = nettoyerMention(textePourIA)
        .replace(new RegExp(
          BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'ig'
        ), '')
        .trim();
    }

    if (!textePourIA) {
      textePourIA = 'Bonjour !';
    }

    const reponse = await genererIA(
      chatId,
      textePourIA
    );

    await sock.sendMessage(jid, {
      text: reponse
    }, {
      quoted: message
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur générale traitement message.'
    );
  } finally {
    if (cleMessage) {
      processingMessages.delete(cleMessage);
    }
  }
}

// ======================================================
// EXPRESS : PAGE D'ÉTAT ET HEALTH CHECK
// ======================================================

const app = express();

app.get('/', async (req, res) => {
  let qrHtml = '<p>QR code indisponible pour le moment.</p>';

  if (currentQrImage && !isConnected) {
    qrHtml = `<img src="${currentQrImage}" alt="QR WhatsApp" style="max-width:300px;width:100%">`;
  }

  res.status(200).send(`
    <!doctype html>
    <html lang="fr">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="15">
      <title>${BOT_NAME}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #111;
          color: #fff;
          text-align: center;
          padding: 30px;
        }
        .card {
          max-width: 500px;
          margin: auto;
          padding: 25px;
          border-radius: 15px;
          background: #222;
        }
        img { border-radius: 10px; }
        .ok { color: #4ade80; }
        .wait { color: #facc15; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>${BOT_NAME}</h1>
        <p>Créé par ${CREATOR_NAME}</p>
        <h2 class="${isConnected ? 'ok' : 'wait'}">
          ${isConnected ? 'WhatsApp connecté' : 'En attente de connexion'}
        </h2>
        ${qrHtml}
        <p>Actualisation automatique toutes les 15 secondes.</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.status(200).json({
    bot: BOT_NAME,
    status: 'ok',
    whatsapp: isConnected,
    groq: Boolean(groq),
    whisper: Boolean(groq),
    elevenlabs: Boolean(
      ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID
    ),
    firebase: Boolean(db),
    voiceReplyEnabled: VOICE_REPLY_ENABLED,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Serveur web actif sur le port ${PORT}.`);
});

// ======================================================
// ENVOI DES MESSAGES AUTOMATIQUES
// ======================================================

async function envoyerMessageGroupe(texte) {
  if (!sockInstance || !isConnected) {
    logger.warn('Message automatique ignoré : WhatsApp non connecté.');
    return;
  }

  if (!WHATSAPP_GROUP_ID) {
    logger.warn('WHATSAPP_GROUP_ID non configuré.');
    return;
  }

  try {
    await sockInstance.sendMessage(WHATSAPP_GROUP_ID, {
      text: texte
    });

    logger.info('Message automatique envoyé.');
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur envoi message automatique.'
    );
  }
}

// ======================================================
// PROGRAMMATION DES RAPPELS
// ======================================================

cron.schedule('30 6 * * *', async () => {
  await envoyerMessageGroupe(
    '🙏 *MÉDITATION DU MATIN*\n\nPrenons quelques instants pour prier, méditer la Parole de Dieu et commencer cette journée avec foi. Que Dieu vous bénisse !'
  );
}, {
  timezone: 'Africa/Abidjan'
});

cron.schedule('0 14 * * 5', async () => {
  const date = obtenirDateAbidjan();
  const dateUtc = new Date(Date.UTC(
    date.annee,
    date.mois - 1,
    date.jour
  ));

  const jour = dateUtc.getUTCDate();
  const dernierJour = new Date(
    Date.UTC(date.annee, date.mois, 0)
  ).getUTCDate();

  const premierVendredi = jour <= 7;
  const dernierVendredi = jour > dernierJour - 7;

  if (premierVendredi || dernierVendredi) {
    await envoyerMessageGroupe(
      '🙏 *RAPPEL DE VEILLÉE*\n\nN’oublions pas notre rendez-vous de prière. Pour les horaires et les détails, veuillez consulter les annonces officielles de l’église.'
    );
  }
}, {
  timezone: 'Africa/Abidjan'
});

cron.schedule('0 14 * * 5,6', async () => {
  await envoyerMessageGroupe(
    '⛪ *PROGRAMME DU WEEK-END*\n\nPréparons nos cœurs pour les activités spirituelles du week-end. Pour les horaires exacts, veuillez consulter les annonces officielles de l’église.'
  );
}, {
  timezone: 'Africa/Abidjan'
});

cron.schedule('0 16 * * 6', async () => {
  await envoyerMessageGroupe(
    '💰 *RAPPEL DES COTISATIONS*\n\nN’oublions pas notre participation aux cotisations prévues pour le studio et l’agapé. Merci à chacun pour son engagement.'
  );
}, {
  timezone: 'Africa/Abidjan'
});

cron.schedule('30 11 * * 0', async () => {
  await envoyerMessageGroupe(
    '🙏 *RAPPEL DU DIMANCHE*\n\nQue chacun se prépare pour le culte et les activités de l’église. Bon dimanche à tous !'
  );
}, {
  timezone: 'Africa/Abidjan'
});

cron.schedule('0 17 * * 0', async () => {
  const rapport = await getCotisationsReport();

  await envoyerMessageGroupe(
    `📊 *RAPPORT HEBDOMADAIRE*\n\n${rapport}`
  );
}, {
  timezone: 'Africa/Abidjan'
});

cron.schedule('0 20 * * 0', async () => {
  await envoyerMessageGroupe(
    '🌙 Bonne soirée à tous ! Que Dieu vous accorde une nuit paisible. N’oublions pas de garder un moment pour la prière.'
  );
}, {
  timezone: 'Africa/Abidjan'
});

// ======================================================
// CONNEXION WHATSAPP
// ======================================================

async function connectToWhatsApp() {
  if (connexionEnCours) {
    logger.info('Connexion WhatsApp déjà en cours.');
    return;
  }

  connexionEnCours = true;
  const generation = ++connectionGeneration;

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_FOLDER);

    let version;

    try {
      const resultat = await fetchLatestBaileysVersion();
      version = resultat.version;
    } catch (error) {
      logger.warn(
        { error: error.message },
        'Impossible de récupérer la version Baileys. Utilisation de la version par défaut.'
      );
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Hbot1', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sockInstance = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      if (generation !== connectionGeneration) return;

      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        try {
          currentQrImage = await QRCode.toDataURL(qr);
          logger.info(
            'QR code disponible sur la page web du bot.'
          );
        } catch (error) {
          logger.error(
            { error: error.message },
            'Erreur génération QR.'
          );
        }
      }

      if (connection === 'open') {
        isConnected = true;
        currentQrImage = null;
        logger.info('WhatsApp connecté avec succès.');
      }

      if (connection === 'close') {
        isConnected = false;
        currentQrImage = null;

        const code =
          lastDisconnect?.error?.output?.statusCode;

        const deconnecte =
          code === DisconnectReason.loggedOut;

        logger.warn(
          { code, deconnecte },
          'Connexion WhatsApp fermée.'
        );

        if (deconnecte) {
          logger.error(
            'Session déconnectée. Supprime les anciennes données de session uniquement si tu souhaites scanner un nouveau QR code.'
          );
          return;
        }

        setTimeout(() => {
          if (generation === connectionGeneration) {
            connectToWhatsApp().catch(error => {
              logger.error(
                { error: error.message },
                'Échec reconnexion WhatsApp.'
              );
            });
          }
        }, 5000);
      }
    });

    sock.ev.on('messages.upsert', async evenement => {
      if (generation !== connectionGeneration) return;

      if (evenement.type !== 'notify') return;

      for (const message of evenement.messages || []) {
        await traiterMessages(sock, message);
      }
    });
  } catch (error) {
    logger.error(
      { error: error.message },
      'Erreur connexion WhatsApp.'
    );

    setTimeout(() => {
      if (generation === connectionGeneration) {
        connectToWhatsApp().catch(err => {
          logger.error(
            { error: err.message },
            'Nouvelle tentative impossible.'
          );
        });
      }
    }, 5000);
  } finally {
    connexionEnCours = false;
  }
}

// ======================================================
// ARRÊT PROPRE
// ======================================================

async function arreter(signal) {
  logger.info(`Signal ${signal} reçu. Arrêt du bot.`);

  try {
    server.close();
  } catch {}

  try {
    sockInstance?.end(
      new Error('Arrêt du processus.')
    );
  } catch {}

  process.exit(0);
}

process.on('SIGINT', () => arreter('SIGINT'));
process.on('SIGTERM', () => arreter('SIGTERM'));

process.on('unhandledRejection', erreur => {
  logger.error(
    { error: String(erreur) },
    'Promesse rejetée non gérée.'
  );
});

process.on('uncaughtException', erreur => {
  logger.error(
    { error: erreur.message, stack: erreur.stack },
    'Exception non interceptée.'
  );
});

// ======================================================
// DÉMARRAGE
// ======================================================

connectToWhatsApp().catch(error => {
  logger.error(
    { error: error.message },
    'Démarrage WhatsApp impossible.'
  );
});
