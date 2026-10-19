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
