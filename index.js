
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import express from 'express';
import Groq, { toFile } from 'groq-sdk';
import admin from 'firebase-admin';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = process.env.BOT_NAME || 'Hbot2';
const CREATOR_NAME = 'Assamoi Yapi Hyppolite';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_AUDIO_MODEL =
  process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3-turbo';
const AUDIO_LANGUAGE = process.env.AUDIO_LANGUAGE || 'fr';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

const VOICE_REPLY_ENABLED =
  (process.env.VOICE_REPLY_ENABLED || 'true').toLowerCase() === 'true';

const AUTH_MODE =
  (process.env.WHATSAPP_AUTH_MODE || 'qr').toLowerCase();

const WHATSAPP_PHONE_NUMBER =
  (process.env.WHATSAPP_PHONE_NUMBER || '').replace(/\D/g, '');

const AUTH_DIR =
  process.env.AUTH_DIR || 'auth_info_baileys_hbot2';

const FIREBASE_SERVICE_ACCOUNT =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  (existsSync('/etc/secrets/serviceAccountKey.json')
    ? '/etc/secrets/serviceAccountKey.json'
    : './serviceAccountKey.json');

const MAX_HISTORY = 12;
const MAX_CONVERSATIONS = 500;
const MAX_PROCESSED_IDS = 1500;
const MAX_MEMORY_ITEMS = 120;

const groq = GROQ_API_KEY
  ? new Groq({ apiKey: GROQ_API_KEY })
  : null;

const app = express();
app.disable('x-powered-by');

let sock = null;
let currentQrDataUrl = null;
let pairingCode = null;
let connectionStatus = 'Initialisation';
let lastConnectionUpdate = new Date().toISOString();

let reconnectTimer = null;
let reconnecting = false;
let connectionGeneration = 0;

let firebaseReady = false;
let db = null;
let firebaseError = '';
let lastError = '';

const conversations = new Map();
const processingMessages = new Set();
const processedMessages = new Set();
const processedOrder = [];

const SYSTEM_PROMPT = `
Tu es ${BOT_NAME}, un assistant WhatsApp intelligent, chaleureux,
cultivé, drôle et bienveillant.

Tu es proche des jeunes, comme un grand frère, mais tu n'assumes
jamais le genre d'une personne si tu ne le connais pas.

Tu réponds principalement en français simple, naturellement,
sans être robotique ni trop long. Tu comprends les fautes,
les abréviations et les messages courts. Utilise les emojis
avec modération.

Tu aides pour les études, la technologie, les téléphones Android,
les PC, JavaScript, Node.js, Firebase, WhatsApp et l'automatisation.

Tu peux aider à comprendre la Bible avec respect, sans faire de
longs sermons non sollicités. Pour les blagues, reste propre
et bienveillant.

Tu as été créé et développé par ${CREATOR_NAME}.
Si on te demande qui t'a créé, réponds clairement :
« J'ai été créé et développé par ${CREATOR_NAME}. »

Utilise les résultats de recherche fournis lorsqu'ils existent.
Ne prétends pas avoir consulté Internet si aucun résultat n'est fourni.
Distingue les faits sûrs des incertitudes.

Ne prétends pas pouvoir envoyer un message ou effectuer une action
externe si tu ne l'as pas réellement faite.

La mémoire fournie peut contenir des informations du groupe :
utilise-les seulement si elles sont pertinentes et ne révèle pas
de secrets ou de données personnelles sensibles.
`;

// ============================================================
// FIREBASE
// ============================================================

function initFirebase() {
  try {
    if (admin.apps.length) {
      db = admin.firestore();
      firebaseReady = true;
      return;
    }

    if (!existsSync(FIREBASE_SERVICE_ACCOUNT)) {
      firebaseError =
        `Fichier Firebase absent : ${FIREBASE_SERVICE_ACCOUNT}`;

      console.warn('[Firebase]', firebaseError);
      return;
    }

    const serviceAccount = JSON.parse(
      readFileSync(FIREBASE_SERVICE_ACCOUNT, 'utf8')
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore();
    firebaseReady = true;

    console.log('[Firebase] Connecté à Firestore.');
  } catch (error) {
    firebaseError = error?.message || String(error);
    console.error('[Firebase] Initialisation impossible:', firebaseError);
  }
}

initFirebase();

function memoryCollection(jid) {
  const safeId = Buffer.from(jid)
    .toString('base64url')
    .slice(0, 120);

  return db
    .collection('hbot2_group_memory')
    .doc(safeId)
    .collection('items');
}

async function getGroupMemory(jid) {
  if (!firebaseReady || !db || !jid) return [];

  try {
    const snap = await memoryCollection(jid)
      .orderBy('createdAt', 'desc')
      .limit(MAX_MEMORY_ITEMS)
      .get();

    return snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .reverse();
  } catch (error) {
    console.error('[Mémoire] Lecture impossible:', error.message);
    return [];
  }
}

async function shouldRemember(text) {
  if (!groq || !text || text.length < 8) return false;

  try {
    const result = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content:
            'Décide si le message contient une information utile et durable ' +
            'pour la mémoire d’un groupe : rendez-vous, décision, événement, ' +
            'tâche, préférence collective ou information importante. ' +
            'Réponds uniquement OUI ou NON. Ne mémorise pas les salutations, ' +
            'plaisanteries ordinaires, mots de passe, numéros privés ou ' +
            'données sensibles.'
        },
        { role: 'user', content: text }
      ]
    });

    return /^oui\b/i.test(
      result.choices?.[0]?.message?.content?.trim() || ''
    );
  } catch (error) {
    console.error('[Mémoire] Analyse impossible:', error.message);
    return false;
  }
}

async function saveMemory(jid, text, author) {
  if (!firebaseReady || !db || !jid || !text) return false;

  try {
    const collection = memoryCollection(jid);

    const recent = await collection
      .orderBy('createdAt', 'desc')
      .limit(8)
      .get();

    const normalizedText = text.trim().toLowerCase();

    if (
      recent.docs.some(
        doc =>
          (doc.data().text || '').trim().toLowerCase() === normalizedText
      )
    ) {
      return false;
    }

    await collection.add({
      text: text.slice(0, 1500),
      author: (author || 'Membre').slice(0, 100),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtISO: new Date().toISOString()
    });

    const all = await collection
      .orderBy('createdAt', 'desc')
      .limit(300)
      .get();

    if (all.size > MAX_MEMORY_ITEMS) {
      const stale = all.docs.slice(MAX_MEMORY_ITEMS);
      const batch = db.batch();

      stale.forEach(doc => batch.delete(doc.ref));

      await batch.commit();
    }

    return true;
  } catch (error) {
    console.error('[Mémoire] Enregistrement impossible:', error.message);
    return false;
  }
}

// ============================================================
// RECHERCHE INTERNET AVEC TAVILY
// ============================================================

function isCurrentInfoQuestion(text) {
  return /\b(aujourd'hui|actuellement|maintenant|dernier|dernière|récent|récente|actualité|actualités|résultat|résultats|score|match|météo|prix actuel|date de|quand sort|en ce moment|cette semaine|202[5-9]|2030)\b/i.test(
    text
  );
}

async function searchWeb(query) {
  if (!TAVILY_API_KEY || !query || !isCurrentInfoQuestion(query)) {
    return '';
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily HTTP ${response.status}`);
    }

    const data = await response.json();
    const lines = [];

    if (data.answer) {
      lines.push(`Résumé du moteur de recherche : ${data.answer}`);
    }

    for (const item of (data.results || []).slice(0, 5)) {
      lines.push(
        `- ${item.title || 'Source'}: ${item.content || ''}` +
        `${item.url ? ` (${item.url})` : ''}`
      );
    }

    return lines.join('\n').slice(0, 7000);
  } catch (error) {
    console.error('[Web] Recherche impossible:', error.message);
    return '';
  }
}

// ============================================================
// INTELLIGENCE ARTIFICIELLE ET HISTORIQUE
// ============================================================

function conversationKey(jid, sender) {
  // Les membres partagent le contexte temporaire du groupe.
  // Les conversations privées restent séparées par contact.
  return jid.endsWith('@g.us') ? jid : `${jid}:${sender || 'unknown'}`;
}

function getHistory(key) {
  if (!conversations.has(key)) {
    if (conversations.size >= MAX_CONVERSATIONS) {
      const oldestKey = conversations.keys().next().value;
      if (oldestKey) conversations.delete(oldestKey);
    }

    conversations.set(key, []);
  }

  return conversations.get(key);
}

async function genererIA(
  jid,
  sender,
  question,
  groupMemory = [],
  webData = ''
) {
  if (!groq) {
    return 'Mon intelligence artificielle n’est pas configurée. ' +
      'Ajoute la variable GROQ_API_KEY dans Render.';
  }

  const key = conversationKey(jid, sender);
  const history = getHistory(key);

  const memoryText = groupMemory.length
    ? groupMemory
        .map(
          item =>
            `• ${item.text}${item.author ? ` (par ${item.author})` : ''}`
        )
        .join('\n')
    : 'Aucune mémoire de groupe enregistrée.';

  const additions =
    `\n\nMémoire du groupe (à utiliser uniquement si utile) :\n${memoryText}` +
    (webData ? `\n\nRésultats de recherche Internet :\n${webData}` : '');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + additions },
    ...history,
    { role: 'user', content: question }
  ];

  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.65,
      max_tokens: 900,
      messages
    });

    const answer =
      response.choices?.[0]?.message?.content?.trim() ||
      'Désolé, je n’ai pas réussi à formuler une réponse.';

    history.push(
      { role: 'user', content: question.slice(0, 4000) },
      { role: 'assistant', content: answer.slice(0, 4000) }
    );

    // Conserver des paires question/réponse complètes.
    while (history.length > MAX_HISTORY) {
      history.splice(0, 2);
    }

    return answer;
  } catch (error) {
    console.error('[Groq] Réponse impossible:', error.message);

    return 'Désolé, j’ai un souci temporaire avec mon intelligence ' +
      'artificielle. Réessaie dans un instant.';
  }
}

// ============================================================
// AUDIO : TRANSCRIPTION ET RÉPONSE VOCALE
// ============================================================

async function transcrireAudio(buffer, mimetype = 'audio/ogg') {
  if (!groq) {
    throw new Error('GROQ_API_KEY absent : transcription vocale indisponible.');
  }

  const file = await toFile(buffer, 'message-audio.ogg', {
    type: mimetype || 'audio/ogg'
  });

  const result = await groq.audio.transcriptions.create({
    file,
    model: GROQ_AUDIO_MODEL,
    language: AUDIO_LANGUAGE,
    response_format: 'text'
  });

  return (typeof result === 'string' ? result : result.text || '').trim();
}

async function genererAudio(text) {
  if (
    !VOICE_REPLY_ENABLED ||
    !ELEVENLABS_API_KEY ||
    !ELEVENLABS_VOICE_ID ||
    !ffmpegPath
  ) {
    return null;
  }

  const mp3Path = path.join(os.tmpdir(), `hbot2-${randomUUID()}.mp3`);
  const oggPath = path.join(os.tmpdir(), `hbot2-${randomUUID()}.ogg`);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/with-timestamps`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          text: text.slice(0, 2500),
          model_id: ELEVENLABS_MODEL,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `ElevenLabs HTTP ${response.status}: ` +
        (await response.text()).slice(0, 300)
      );
    }

    const data = await response.json();

    if (!data.audio_base64) {
      throw new Error('Audio ElevenLabs absent dans la réponse.');
    }

    await writeFile(mp3Path, Buffer.from(data.audio_base64, 'base64'));

    await new Promise((resolve, reject) => {
      const proc = spawn(
        ffmpegPath,
        [
          '-y',
          '-i', mp3Path,
          '-vn',
          '-ac', '1',
          '-ar', '48000',
          '-c:a', 'libopus',
          '-b:a', '32k',
          '-application', 'voip',
          oggPath
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );

      let stderr = '';

      proc.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      proc.on('error', reject);

      proc.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`FFmpeg code ${code}: ${stderr.slice(-500)}`)
          );
        }
      });
    });

    return await readFile(oggPath);
  } catch (error) {
    console.error('[Voix] Synthèse audio impossible:', error.message);
    return null;
  } finally {
    await Promise.all([
      unlink(mp3Path).catch(() => {}),
      unlink(oggPath).catch(() => {})
    ]);
  }
}

async function envoyerReponse(
  jid,
  text,
  isVoice = false,
  quotedMessage = null
) {
  if (!sock) return;

  if (isVoice && VOICE_REPLY_ENABLED) {
    const audio = await genererAudio(text);

    if (audio) {
      try {
        await sock.sendMessage(
          jid,
          {
            audio,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
          },
          quotedMessage ? { quoted: quotedMessage } : {}
        );

        return;
      } catch (error) {
        console.error('[WhatsApp] Envoi vocal impossible:', error.message);
      }
    }
  }

  await sock.sendMessage(
    jid,
    { text },
    quotedMessage ? { quoted: quotedMessage } : {}
  );
}

// ============================================================
// LECTURE DES MESSAGES WHATSAPP
// ============================================================

function getMessageContent(message) {
  let content = message?.message;

  while (
    content?.ephemeralMessage?.message ||
    content?.viewOnceMessage?.message ||
    content?.viewOnceMessageV2?.message
  ) {
    content =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message;
  }

  return content || {};
}

function extraireTexte(message) {
  const content = getMessageContent(message);

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  );
}

function extraireAudio(message) {
  const content = getMessageContent(message);

  if (content.audioMessage) {
    return {
      audio: content.audioMessage,
      ptt: Boolean(content.audioMessage.ptt)
    };
  }

  if (
    content.documentMessage &&
    /audio|ogg|mpeg|mp4/i.test(content.documentMessage.mimetype || '')
  ) {
    return {
      audio: content.documentMessage,
      ptt: false
    };
  }

  return null;
}

function getAuthorName(message) {
  return message.pushName || message.verifiedBizName || 'Membre';
}

function hbot2EstMentionne(message, text) {
  const content = getMessageContent(message);

  const context =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.audioMessage?.contextInfo ||
    {};

  const botId = sock?.user?.id?.split(':')[0];

  if (
    botId &&
    Array.isArray(context.mentionedJid) &&
    context.mentionedJid.some(jid => jid.split('@')[0].split(':')[0] === botId)
  ) {
    return true;
  }

  return /\bhbot\s*2\b|\bhbot2\b/i.test(text || '');
}

function nettoyerQuestion(text) {
  return (text || '')
    .replace(/@\d{5,}/g, '')
    .replace(/\bhbot\s*2\b|\bhbot2\b/ig, '')
    .trim();
}

// ============================================================
// COMMANDES
// ============================================================

async function traiterCommande(jid, text, message, isGroup, sender) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();

  const commandes = [
    '!help',
    '!aide',
    '!id',
    '!createur',
    '!hbot2',
    '!resetia',
    '!memoire'
  ];

  if (!commandes.includes(cmd)) return false;

  if (cmd === '!help' || cmd === '!aide') {
    await envoyerReponse(
      jid,
      `🤖 *Commandes ${BOT_NAME}*\n` +
      '!help ou !aide — afficher l’aide\n' +
      '!hbot2 — me présenter\n' +
      '!createur — connaître mon créateur\n' +
      '!id — afficher l’identifiant du chat\n' +
      '!resetia — réinitialiser le contexte IA\n' +
      '!memoire — afficher la mémoire du groupe\n\n' +
      `Dans un groupe, mentionne @${BOT_NAME} pour poser une question. ` +
      'Les commandes fonctionnent sans mention.',
      false,
      message
    );
  } else if (cmd === '!id') {
    await envoyerReponse(
      jid,
      `Identifiant de ce chat :\n${jid}\n` +
      `${isGroup ? `Expéditeur : ${sender}` : ''}`,
      false,
      message
    );
  } else if (cmd === '!createur') {
    await envoyerReponse(
      jid,
      `J'ai été créé et développé par ${CREATOR_NAME}.`,
      false,
      message
    );
  } else if (cmd === '!hbot2') {
    await envoyerReponse(
      jid,
      `Salut ! Moi, c’est ${BOT_NAME} 🤖 ` +
      'Je suis un assistant intelligent, chaleureux et bienveillant. ' +
      `Mon créateur est ${CREATOR_NAME}.`,
      false,
      message
    );
  } else if (cmd === '!resetia') {
    conversations.delete(conversationKey(jid, sender));

    await envoyerReponse(
      jid,
      'C’est fait : le contexte récent de cette conversation a été réinitialisé.',
      false,
      message
    );
  } else if (cmd === '!memoire') {
    if (!isGroup) {
      await envoyerReponse(
        jid,
        'La mémoire persistante est prévue pour les groupes WhatsApp.',
        false,
        message
      );
    } else {
      const memory = await getGroupMemory(jid);

      const output = memory.length
        ? memory
            .slice(-20)
            .map((item, index) => `${index + 1}. ${item.text}`)
            .join('\n')
        : 'Aucune information enregistrée pour le moment.';

      await envoyerReponse(
        jid,
        `🧠 *Mémoire du groupe*\n${output}`.slice(0, 6000),
        false,
        message
      );
    }
  }

  return true;
}

// ============================================================
// ANTI-DOUBLONS ET TRAITEMENT DES MESSAGES
// ============================================================

function markMessageProcessed(id) {
  if (!id) return;

  processedMessages.add(id);
  processedOrder.push(id);

  while (processedOrder.length > MAX_PROCESSED_IDS) {
    const old = processedOrder.shift();
    processedMessages.delete(old);
  }
}

async function traiterMessage(message) {
  const jid = message.key?.remoteJid;
  const messageId = message.key?.id;

  if (
    !jid ||
    !messageId ||
    jid === 'status@broadcast' ||
    message.key?.fromMe
  ) {
    return;
  }

  if (
    processedMessages.has(messageId) ||
    processingMessages.has(messageId)
  ) {
    return;
  }

  processingMessages.add(messageId);

  try {
    const isGroup = jid.endsWith('@g.us');
    const sender = message.key.participant || jid;
    const author = getAuthorName(message);

    let text = extraireTexte(message);
    const audioInfo = extraireAudio(message);
    let isVoice = false;

    if (audioInfo) {
      try {
        const media = await downloadMediaMessage(
          message,
          'buffer',
          {},
          {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sock?.updateMediaMessage
          }
        );

        const transcript = await transcrireAudio(
          media,
          audioInfo.audio.mimetype || 'audio/ogg'
        );

        if (transcript) {
          text = transcript;
          isVoice = true;

          console.log(`[Voix] ${author}: ${transcript.slice(0, 180)}`);
        } else {
          if (!isGroup || hbot2EstMentionne(message, '')) {
            await envoyerReponse(
              jid,
              'Je n’ai pas réussi à comprendre le vocal. ' +
              'Peux-tu réessayer ou écrire ton message ?',
              false,
              message
            );
          }

          return;
        }
      } catch (error) {
        console.error('[Voix] Transcription impossible:', error.message);

        if (!isGroup || hbot2EstMentionne(message, '')) {
          await envoyerReponse(
            jid,
            'Je n’arrive pas à transcrire ce vocal pour le moment. ' +
            'Réessaie un peu plus tard.',
            false,
            message
          );
        }

        return;
      }
    }

    if (!text?.trim()) return;

    text = text.trim();

    // Les commandes fonctionnent même sans mention dans les groupes.
    if (
      text.startsWith('!') &&
      await traiterCommande(jid, text, message, isGroup, sender)
    ) {
      return;
    }

    // Les messages ordinaires d'un groupe ne reçoivent pas de réponse
    // sauf si Hbot2 est mentionné. Les informations utiles peuvent
    // toutefois être enregistrées dans la mémoire.
    if (isGroup && !hbot2EstMentionne(message, text)) {
      if (await shouldRemember(text)) {
        const saved = await saveMemory(jid, text, author);

        if (saved) {
          console.log(
            `[Mémoire] Information du groupe enregistrée (${author}).`
          );
        }
      }

      return;
    }

    const question = nettoyerQuestion(text) || text;

    if (!question) {
      await envoyerReponse(
        jid,
        'Oui, je t’écoute 😊 Que veux-tu savoir ?',
        isVoice,
        message
      );

      return;
    }

    const webData = await searchWeb(question);
    const memory = isGroup ? await getGroupMemory(jid) : [];

    const answer = await genererIA(
      jid,
      sender,
      question,
      memory,
      webData
    );

    await envoyerReponse(jid, answer, isVoice, message);

    if (isGroup && await shouldRemember(question)) {
      await saveMemory(jid, question, author);
    }
  } catch (error) {
    lastError = error?.message || String(error);

    console.error('[Message] Erreur de traitement:', error);

    try {
      await envoyerReponse(
        message.key.remoteJid,
        'Désolé, une erreur temporaire est survenue. Réessaie dans un instant.',
        false,
        message
      );
    } catch {}
  } finally {
    processingMessages.delete(messageId);
    markMessageProcessed(messageId);
  }
}

// ============================================================
// PAGE WEB DE STATUT
// ============================================================

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    bot: BOT_NAME,
    status: connectionStatus,
    authMode: AUTH_MODE,
    groq: Boolean(groq),
    firebase: firebaseReady,
    webSearch: Boolean(TAVILY_API_KEY),
    voiceRecognition: Boolean(groq),
    voiceResponse: Boolean(
      VOICE_REPLY_ENABLED &&
      ELEVENLABS_API_KEY &&
      ELEVENLABS_VOICE_ID &&
      ffmpegPath
    ),
    lastConnectionUpdate,
    lastError: lastError || undefined
  });
});

app.get('/', async (_req, res) => {
  let authHtml =
    '<p class="muted">Aucun QR code disponible pour le moment.</p>';

  if (AUTH_MODE === 'pairing') {
    authHtml = pairingCode
      ? `<div class="pairing">${escapeHtml(pairingCode)}</div>
         <p>Sur ton téléphone : WhatsApp → Appareils connectés →
         Connecter un appareil → Connecter avec un numéro de téléphone.
         Saisis ensuite le code ci-dessus.</p>`
      : '<p class="muted">En attente du code d’appairage. ' +
        'Vérifie les journaux Render si le code ne paraît pas.</p>';
  } else if (currentQrDataUrl) {
    authHtml =
      `<img class="qr" src="${currentQrDataUrl}" alt="QR code WhatsApp">`;
  }

  res.type('html').send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>${escapeHtml(BOT_NAME)} — État</title>
<style>
body {
  font-family: system-ui, Arial, sans-serif;
  background: #10131a;
  color: #f4f6fb;
  margin: 0;
  padding: 24px;
}
.card {
  max-width: 680px;
  margin: 0 auto;
  background: #1b202b;
  border: 1px solid #303849;
  border-radius: 18px;
  padding: 24px;
}
h1 { margin-top: 0; }
.status { font-weight: 700; color: #9ff0b4; }
.muted { color: #b9c0cf; }
.qr {
  display: block;
  width: min(320px, 100%);
  margin: 20px auto;
  background: white;
  padding: 10px;
  border-radius: 12px;
}
.pairing {
  font-size: 2.1rem;
  letter-spacing: .18em;
  font-weight: 800;
  text-align: center;
  padding: 28px 8px;
  color: #a6ffb4;
}
.row {
  padding: 9px 0;
  border-bottom: 1px solid #303849;
}
.warning {
  color: #ffd58a;
  font-size: .9rem;
  margin-top: 18px;
}
</style>
</head>
<body>
<main class="card">
<h1>🤖 ${escapeHtml(BOT_NAME)}</h1>
<p>État WhatsApp :
<span class="status">${escapeHtml(connectionStatus)}</span></p>
<div class="row">Authentification : ${escapeHtml(AUTH_MODE)}</div>
<div class="row">Intelligence artificielle :
${groq ? 'Configurée' : 'GROQ_API_KEY manquante'}</div>
<div class="row">Firebase :
${firebaseReady ? 'Connecté' : 'Non connecté (mémoire indisponible)'}</div>
<div class="row">Recherche web :
${TAVILY_API_KEY ? 'Configurée' : 'Non configurée'}</div>
<div class="row">Réponse vocale :
${VOICE_REPLY_ENABLED && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID
    ? 'Configurée'
    : 'Non configurée'}</div>
<h2>${AUTH_MODE === 'pairing' ? 'Code d’appairage' : 'QR code WhatsApp'}</h2>
${authHtml}
<p class="muted">Cette page se rafraîchit toutes les 10 secondes.</p>
<p class="warning">Sécurité : ne partage pas cette page, le QR code
ou le code d’appairage. Ils permettent de lier ton compte WhatsApp.</p>
</main>
</body>
</html>`);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Serveur] ${BOT_NAME} disponible sur le port ${PORT}.`);
});

// ============================================================
// CONNEXION WHATSAPP ET RECONNEXION
// ============================================================

async function connecterWhatsApp() {
  if (reconnecting) return;

  reconnecting = true;
  const generation = ++connectionGeneration;

  try {
    connectionStatus = 'Connexion à WhatsApp…';
    lastConnectionUpdate = new Date().toISOString();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({
        level: process.env.LOG_LEVEL || 'silent'
      }),
      printQRInTerminal: false,
      browser: ['Hbot2', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    // Le code d'appairage est généré par WhatsApp.
    // Ce n'est pas un mot de passe personnalisé.
    if (AUTH_MODE === 'pairing' && !state.creds.registered) {
      if (!WHATSAPP_PHONE_NUMBER || WHATSAPP_PHONE_NUMBER.length < 8) {
        throw new Error(
          'Mode pairing sélectionné, mais WHATSAPP_PHONE_NUMBER est absent ' +
          'ou invalide. Ajoute le numéro international sans + ni espaces ' +
          'dans les variables Render.'
        );
      }

      setTimeout(async () => {
        if (
          generation !== connectionGeneration ||
          state.creds.registered
        ) {
          return;
        }

        try {
          const code = await sock.requestPairingCode(
            WHATSAPP_PHONE_NUMBER
          );

          pairingCode =
            String(code).match(/.{1,4}/g)?.join('-') || String(code);

          connectionStatus =
            'Code d’appairage prêt — attente de validation';

          lastConnectionUpdate = new Date().toISOString();

          console.log('\n========================================');
          console.log(`[${BOT_NAME}] CODE D’APPAIRAGE : ${pairingCode}`);
          console.log('Ne partage pas ce code.');
          console.log('========================================\n');
        } catch (error) {
          lastError = error?.message || String(error);

          console.error(
            '[Pairing] Impossible de générer le code :',
            lastError
          );

          connectionStatus =
            'Erreur de génération du code d’appairage';
        }
      }, 1500);
    }

    sock.ev.on('connection.update', async update => {
      if (generation !== connectionGeneration) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr && AUTH_MODE !== 'pairing') {
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, {
            width: 320,
            margin: 2
          });
        } catch (error) {
          console.error('[QR] Génération impossible:', error.message);
        }

        connectionStatus = 'QR code prêt — scanne-le avec WhatsApp';
        lastConnectionUpdate = new Date().toISOString();

        console.log(
          `[${BOT_NAME}] QR code disponible sur la page web du service.`
        );
      }

      if (connection === 'connecting') {
        connectionStatus = 'Connexion à WhatsApp…';
        lastConnectionUpdate = new Date().toISOString();
      }

      if (connection === 'open') {
        currentQrDataUrl = null;
        pairingCode = null;

        connectionStatus = 'Connecté à WhatsApp';
        lastConnectionUpdate = new Date().toISOString();
        lastError = '';

        console.log(`[${BOT_NAME}] Connecté à WhatsApp.`);
      }

      if (connection === 'close') {
        const statusCode =
          new Boom(lastDisconnect?.error).output?.statusCode;

        connectionStatus =
          `Connexion fermée (${statusCode || 'inconnue'})`;

        lastConnectionUpdate = new Date().toISOString();

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        console.error(
          `[${BOT_NAME}] Connexion fermée. ` +
          `Code=${statusCode || 'inconnu'}, loggedOut=${loggedOut}`
        );

        if (loggedOut) {
          connectionStatus =
            'Session déconnectée — il faut relier le compte';

          console.error(
            `[${BOT_NAME}] WhatsApp a déconnecté la session. ` +
            `Il faudra supprimer le dossier ${AUTH_DIR} de session ` +
            'et relier le compte avant de redémarrer.'
          );

          reconnecting = false;
          return;
        }

        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            reconnecting = false;

            connecterWhatsApp().catch(error => {
              console.error('[Reconnect] Échec:', error.message);
            });
          }, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages || []) {
        traiterMessage(message).catch(error => {
          console.error('[Message] Erreur non gérée:', error.message);
        });
      }
    });
  } catch (error) {
    lastError = error?.message || String(error);
    connectionStatus = 'Erreur de connexion';

    console.error('[WhatsApp] Impossible de démarrer:', lastError);

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnecting = false;

        connecterWhatsApp().catch(err => {
          console.error('[Reconnect] Échec:', err.message);
        });
      }, 7000);
    }
  } finally {
    if (
      !reconnectTimer &&
      connectionStatus !== 'Erreur de connexion'
    ) {
      reconnecting = false;
    }
  }
}

// ============================================================
// GESTION DES ERREURS ET ARRÊT
// ============================================================

process.on('unhandledRejection', error => {
  console.error('[Process] Promesse rejetée:', error);
});

process.on('uncaughtException', error => {
  console.error('[Process] Exception non interceptée:', error);
  lastError = error?.message || String(error);
});

process.on('SIGTERM', () => {
  console.log('[Process] SIGTERM reçu. Arrêt…');

  try {
    sock?.end(undefined);
  } catch {}

  process.exit(0);
});

connecterWhatsApp().catch(error => {
  console.error('[Démarrage] Erreur fatale:', error);
  process.exitCode = 1;
});
