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
import { spawn } from 'child_process';
import {
  readFileSync,
  existsSync
} from 'fs';
import { once } from 'events';

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 10000;
const CREATOR_NAME = 'Assamoi Yapi Hyppolite';
const BOT_NAME = 'Hbot2';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL =
  process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

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

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY || '';

const VOICE_REPLY_ENABLED =
  String(process.env.VOICE_REPLY_ENABLED ?? 'true')
    .toLowerCase() === 'true';

const MAX_HISTORY = 12;
const MAX_CONVERSATIONS = 500;
const MAX_GROUP_MEMORY = 120;

// ============================================================
// ETAT GLOBAL
// ============================================================

let sockInstance = null;
let isConnected = false;
let currentQrImage = null;
let reconnecting = false;
let db = null;
let groq = null;
let connectionGeneration = 0;

const conversations = new Map();
const processingMessages = new Set();

// ============================================================
// EXPRESS / PAGE WEB
// ============================================================

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>HBOT2</title>
<style>
body{margin:0;background:#101010;color:#fff;font-family:Arial,sans-serif;text-align:center}
.container{max-width:650px;margin:35px auto;padding:25px;background:#1c1c1c;border-radius:18px}
h1{color:#25D366}
img{width:280px;max-width:90%;background:#fff;padding:8px;border-radius:12px}
.info{text-align:left;line-height:1.8;margin-top:25px;overflow-wrap:anywhere}
.ok{color:#25D366}.no{color:#ff6565}
</style>
</head>
<body>
<div class="container">
<h1>🤖 HBOT2</h1>
<h3>${isConnected ? '🟢 Connecté à WhatsApp' : '🟡 En attente de connexion'}</h3>
${currentQrImage ? `<p>Scanne ce QR code avec WhatsApp.</p><img src="${currentQrImage}" alt="QR WhatsApp">` : ''}
<div class="info">
<p>👤 Créateur : <strong>${CREATOR_NAME}</strong></p>
<p>🧠 Groq : <span class="${groq ? 'ok' : 'no'}">${groq ? 'ACTIF' : 'INACTIF'}</span></p>
<p>🎙️ Reconnaissance vocale : <span class="${groq ? 'ok' : 'no'}">${groq ? 'DISPONIBLE' : 'INACTIVE'}</span></p>
<p>🔊 Réponse vocale : <span class="${VOICE_REPLY_ENABLED && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID ? 'ok' : 'no'}">${VOICE_REPLY_ENABLED && ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID ? 'ACTIVE' : 'INACTIVE'}</span></p>
<p>🌐 Recherche Internet : <span class="${TAVILY_API_KEY ? 'ok' : 'no'}">${TAVILY_API_KEY ? 'ACTIVE' : 'INACTIVE'}</span></p>
<p>🔥 Mémoire Firestore : <span class="${db ? 'ok' : 'no'}">${db ? 'ACTIVE' : 'INACTIVE'}</span></p>
<p>🧠 Modèle IA : ${GROQ_MODEL}</p>
</div>
</div>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: BOT_NAME,
    creator: CREATOR_NAME,
    whatsapp: isConnected,
    groq: Boolean(GROQ_API_KEY),
    whisper: Boolean(GROQ_API_KEY),
    elevenlabs: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
    webSearch: Boolean(TAVILY_API_KEY),
    groupMemory: Boolean(db)
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 ${BOT_NAME} disponible sur le port ${PORT}`);
});

// ============================================================
// GROQ
// ============================================================

if (GROQ_API_KEY) {
  groq = new Groq({ apiKey: GROQ_API_KEY });
  console.log('✅ Groq activé');
} else {
  console.warn('⚠️ GROQ_API_KEY manquante');
}

// ============================================================
// FIREBASE / FIRESTORE
// ============================================================

try {
  const renderPath = '/etc/secrets/serviceAccountKey.json';
  const localPath = './serviceAccountKey.json';
  let serviceAccount = null;

  if (existsSync(renderPath)) {
    serviceAccount = JSON.parse(readFileSync(renderPath, 'utf8'));
  } else if (existsSync(localPath)) {
    serviceAccount = JSON.parse(readFileSync(localPath, 'utf8'));
  }

  if (serviceAccount) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    console.log('✅ Firestore activé');
  } else {
    console.warn('⚠️ Clé Firebase non trouvée : mémoire désactivée');
  }
} catch (error) {
  console.error('❌ Firebase :', error.message);
}

// ============================================================
// PROMPT SYSTEME
// ============================================================

const SYSTEM_PROMPT = `
Tu es Hbot2, un assistant intelligent utilisé sur WhatsApp.

IDENTITÉ
Ton créateur est ${CREATOR_NAME}.
Si on te demande qui tu es ou qui t'a créé, réponds clairement :
"Je suis Hbot2, créé et développé par ${CREATOR_NAME}."
Tu es un programme informatique, pas un être humain.

PERSONNALITÉ
Sois chaleureux, naturel, cultivé, respectueux et utile.
Utilise un français simple par défaut.
Comprends les fautes de frappe et les messages courts.
Évite les réponses inutilement longues.
N'invente pas le genre d'une personne.

CAPACITÉS
Aide en informatique, sciences, histoire, géographie,
mathématiques, rédaction, traduction, études et vie quotidienne.
Réponds aux questions générales avec précision.

ACTUALITÉ
Utilise les résultats Internet fournis lorsqu'ils sont disponibles.
Ne prétends pas avoir vérifié une information récente si aucune
recherche n'a été effectuée. Distingue les faits des incertitudes.

MÉMOIRE DES GROUPES
Les informations sous "MÉMOIRE DU GROUPE" appartiennent au groupe
dans lequel la question est posée.
Utilise-les pour retrouver les cotisations, montants, programmes,
sorties, voyages, réunions, dates, heures, lieux et décisions.
N'invente jamais une information absente.
Si des informations se contredisent, signale-le.
Ne révèle pas la mémoire d'un autre groupe.

COMPORTEMENT
Réponds par écrit aux messages écrits.
Pour les messages vocaux, réponds vocalement si le service vocal
est disponible ; sinon, réponds par écrit.
Ne répète pas inutilement la transcription du message vocal.
N'envoie aucun rappel automatique de cotisation, méditation,
veillée ou programme.
Les informations mémorisées doivent être rappelées sur demande.
`;

// ============================================================
// IDENTIFIANT DE MÉMOIRE DU GROUPE
// ============================================================

function getMemoryCollectionId(jid) {
  return Buffer.from(jid).toString('base64url');
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

// ============================================================
// DÉTECTER LES INFORMATIONS IMPORTANTES
// ============================================================

function messageSembleImportant(text) {
  const contenu = String(text || '').toLowerCase();

  const mots = [
    'cotisation', 'cotisé', 'cotiser', 'fcfa', 'franc',
    'prix', 'montant', 'payer', 'paiement', 'argent',
    'sortie', 'voyage', 'déplacement', 'excursion',
    'programme', 'réunion', 'rendez-vous', 'rdv',
    'demain', "aujourd'hui", 'aujourd’hui',
    'samedi', 'dimanche', 'lundi', 'mardi', 'mercredi',
    'jeudi', 'vendredi', 'janvier', 'février', 'mars',
    'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre',
    'heure', 'lieu', 'adresse', 'important', 'annonce',
    'décision', 'décidé', 'confirmé', 'confirmation',
    'activité', 'événement', 'date', 'répétition'
  ];

  return mots.some(mot => contenu.includes(mot));
}

// ============================================================
// ENREGISTRER UNE INFORMATION DU GROUPE
// ============================================================

async function memoriserGroupe(jid, information, auteur = '') {
  if (!db || !isGroupJid(jid) || !information) return;

  try {
    const collectionId = getMemoryCollectionId(jid);

    await db
      .collection('hbot2_group_memory')
      .doc(collectionId)
      .collection('items')
      .add({
        texte: String(information).slice(0, 5000),
        auteur: String(auteur || 'membre').slice(0, 200),
        date: admin.firestore.FieldValue.serverTimestamp(),
        dateISO: new Date().toISOString()
      });

    console.log(`🧠 Information mémorisée pour ${jid}`);
  } catch (error) {
    console.error('❌ Mémoire Firestore :', error.message);
  }
}

// ============================================================
// LIRE LA MÉMOIRE DU GROUPE
// ============================================================

async function recupererMemoireGroupe(jid, limite = MAX_GROUP_MEMORY) {
  if (!db || !isGroupJid(jid)) return [];

  try {
    const collectionId = getMemoryCollectionId(jid);

    const snapshot = await db
      .collection('hbot2_group_memory')
      .doc(collectionId)
      .collection('items')
      .orderBy('dateISO', 'desc')
      .limit(limite)
      .get();

    return snapshot.docs
      .map(doc => doc.data())
      .reverse();
  } catch (error) {
    console.error('❌ Lecture mémoire :', error.message);
    return [];
  }
}

// ============================================================
// ANALYSER SI UNE INFORMATION DOIT ÊTRE MÉMORISÉE
// ============================================================

async function analyserInformation(text) {
  if (!groq || !messageSembleImportant(text)) return false;

  try {
    const result = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: `Réponds uniquement OUI ou NON.
OUI si le message contient une information pratique que le
groupe pourrait vouloir retrouver plus tard : cotisation,
argent, date, heure, lieu, sortie, voyage, programme, réunion,
annonce, décision ou événement.
NON pour les conversations ordinaires, salutations et plaisanteries.`
        },
        { role: 'user', content: String(text).slice(0, 4000) }
      ],
      temperature: 0,
      max_tokens: 5
    });

    return result.choices?.[0]?.message?.content
      ?.trim().toUpperCase().startsWith('OUI') || false;
  } catch (error) {
    console.error('❌ Analyse mémoire :', error.message);
    return false;
  }
}

// ============================================================
// RECHERCHE INTERNET TAVILY
// ============================================================

function questionSembleActuelle(text) {
  const contenu = String(text || '').toLowerCase();

  const mots = [
    "aujourd'hui", 'aujourd’hui', 'maintenant',
    'actuellement', 'ce soir', 'demain', 'hier',
    'cette semaine', 'cette année', 'actualité',
    'actualités', 'dernières nouvelles', 'news',
    'récent', 'récente', 'dernier', 'dernière',
    'score', 'résultat', 'match', 'météo',
    'prix actuel', 'cours actuel', 'président actuel',
    'premier ministre', 'horaires', 'ouvert maintenant'
  ];

  return mots.some(mot => contenu.includes(mot));
}

async function questionNecessiteWeb(text) {
  if (questionSembleActuelle(text)) return true;
  if (!groq) return false;

  try {
    const result = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: `Réponds uniquement OUI ou NON.
OUI si la question nécessite des informations récentes ou
susceptibles d'avoir changé : actualités, sport, météo, prix,
événements récents, fonctions officielles ou horaires.
NON pour les connaissances générales stables.`
        },
        { role: 'user', content: String(text).slice(0, 3000) }
      ],
      temperature: 0,
      max_tokens: 5
    });

    return result.choices?.[0]?.message?.content
      ?.trim().toUpperCase().startsWith('OUI') || false;
  } catch {
    return false;
  }
}

async function rechercherInternet(query) {
  if (!TAVILY_API_KEY) return null;

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'advanced',
        topic: 'general',
        max_results: 5,
        include_answer: true,
        include_raw_content: false
      }),
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      throw new Error(`Tavily HTTP ${response.status}`);
    }

    const data = await response.json();

    return {
      answer: data.answer || '',
      results: (data.results || []).map(item => ({
        title: item.title || '',
        url: item.url || '',
        content: item.content || ''
      }))
    };
  } catch (error) {
    console.error('❌ Recherche Web :', error.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPTION VOCALE GROQ / WHISPER
// ============================================================

async function transcrireAudio(audioBuffer, mimetype = 'audio/ogg') {
  if (!groq) return '';

  try {
    let extension = 'ogg';

    if (/mp3|mpeg/i.test(mimetype)) extension = 'mp3';
    else if (/m4a|mp4/i.test(mimetype)) extension = 'm4a';
    else if (/webm/i.test(mimetype)) extension = 'webm';
    else if (/wav/i.test(mimetype)) extension = 'wav';

    const file = await toFile(audioBuffer, `hbot2.${extension}`);

    const result = await groq.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      language: WHISPER_LANGUAGE,
      response_format: 'json',
      temperature: 0
    });

    return result.text?.trim() || '';
  } catch (error) {
    console.error('❌ Transcription Whisper :', error.message);
    return '';
  }
}

// ============================================================
// PRÉPARER LE TEXTE POUR LA VOIX
// ============================================================

function nettoyerTexteVocal(text) {
  return String(text || '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[*_~`#]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .trim()
    .slice(0, 1800);
}

// ============================================================
// CONVERTIR MP3 EN OGG OPUS POUR WHATSAPP
// ============================================================

async function convertirEnOpus(mp3Buffer) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static indisponible');
  }

  const proc = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-ar', '48000',
    '-ac', '1',
    '-f', 'ogg',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const output = [];
  const errors = [];

  proc.stdout.on('data', chunk => output.push(chunk));
  proc.stderr.on('data', chunk => errors.push(chunk));

  proc.stdin.end(mp3Buffer);

  const [code] = await once(proc, 'close');

  if (code !== 0) {
    throw new Error(Buffer.concat(errors).toString().slice(0, 500));
  }

  return Buffer.concat(output);
}

// ============================================================
// GÉNÉRER ET ENVOYER UNE RÉPONSE VOCALE
// ============================================================

async function envoyerVocal(jid, text, quoted) {
  if (
    !sockInstance ||
    !VOICE_REPLY_ENABLED ||
    !ELEVENLABS_API_KEY ||
    !ELEVENLABS_VOICE_ID
  ) {
    return false;
  }

  try {
    const cleanText = nettoyerTexteVocal(text);
    if (!cleanText) return false;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: ELEVENLABS_MODEL
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs HTTP ${response.status}`);
    }

    const mp3 = Buffer.from(await response.arrayBuffer());
    const opus = await convertirEnOpus(mp3);

    await sockInstance.sendMessage(
      jid,
      {
        audio: opus,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true
      },
      { quoted }
    );

    return true;
  } catch (error) {
    console.error('❌ Réponse vocale :', error.message);
    return false;
  }
}

// ============================================================
// GÉNÉRER LA RÉPONSE IA
// ============================================================

async function genererIA(jid, question, groupMemory = [], webData = null) {
  if (!groq) {
    return '⚠️ Le service IA Groq n’est pas configuré.';
  }

  if (!conversations.has(jid)) {
    conversations.set(jid, []);
  }

  const history = conversations.get(jid);

  const memoryText = groupMemory.length
    ? groupMemory.map(item =>
        `- ${item.texte} (source : ${item.auteur || 'membre'}, date : ${item.dateISO || 'inconnue'})`
      ).join('\n')
    : 'Aucune information mémorisée pour ce groupe.';

  let webText = 'Aucune recherche Internet effectuée.';

  if (webData) {
    webText = `Résumé : ${webData.answer || 'Aucun résumé disponible.'}\n`;

    for (const item of webData.results || []) {
      webText += `\nTitre : ${item.title}\nURL : ${item.url}\nContenu : ${item.content}\n`;
    }
  }

  const context = `
MÉMOIRE DU GROUPE :
${memoryText}

RÉSULTATS INTERNET :
${webText}

QUESTION DE L'UTILISATEUR :
${question}

Réponds directement à la question. Ne présente pas les résultats
de transcription comme une réponse. N'invente aucun fait.
`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: context }
  ];

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 1200
    });

    const answer = completion.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return 'Je n’ai pas réussi à formuler une réponse.';
    }

    history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer }
    );

    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    while (conversations.size > MAX_CONVERSATIONS) {
      conversations.delete(conversations.keys().next().value);
    }

    return answer;
  } catch (error) {
    console.error('❌ Groq IA :', error.message);
    return '⚠️ Je rencontre actuellement un problème avec mon intelligence artificielle.';
  }
}

// ============================================================
// EXTRAIRE LE TEXTE DU MESSAGE
// ============================================================

function extraireTexte(msg) {
  const message = msg?.message;
  if (!message) return '';

  const contenu =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;

  return (
    contenu.conversation ||
    contenu.extendedTextMessage?.text ||
    contenu.imageMessage?.caption ||
    contenu.videoMessage?.caption ||
    contenu.documentMessage?.caption ||
    contenu.buttonsResponseMessage?.selectedDisplayText ||
    contenu.listResponseMessage?.title ||
    ''
  );
}

function extraireAudio(msg) {
  const message = msg?.message;
  if (!message) return null;

  const contenu =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message;

  if (contenu.audioMessage) return contenu.audioMessage;

  return null;
}

function getAuthorName(msg) {
  return msg.pushName || msg.key?.participant || 'membre';
}

function hbot2EstMentionne(text) {
  return /\bhbot2\b/i.test(String(text || ''));
}

function nettoyerQuestion(text) {
  return String(text || '')
    .replace(/\bhbot2\b/gi, '')
    .replace(/^[\s,;:!?-]+/, '')
    .trim();
}

// ============================================================
// ENVOYER UNE RÉPONSE
// ============================================================

async function envoyerReponse(jid, text, quoted, isVoice = false) {
  if (isVoice) {
    const sent = await envoyerVocal(jid, text, quoted);
    if (sent) return;
  }

  await sockInstance.sendMessage(
    jid,
    { text },
    { quoted }
  );
}

// ============================================================
// COMMANDES WHATSAPP
// ============================================================

async function traiterCommande(jid, text, quoted, isVoice = false) {
  const command = String(text || '').trim().toLowerCase();

  if (['!help', '!aide'].includes(command)) {
    await envoyerReponse(jid,
      `🤖 *HBOT2 — AIDE*

!help — Afficher l'aide
!aide — Afficher l'aide
!id — Afficher l'identifiant du chat
!createur — Connaître mon créateur
!hbot2 — Présenter Hbot2
!resetia — Réinitialiser la conversation IA
!memoire — Consulter les informations mémorisées du groupe

Dans un groupe, écris "Hbot2" suivi de ta question.

🧠 Je mémorise les informations importantes du groupe.
🎙️ Je comprends les messages vocaux.
🌐 Je peux rechercher des informations actuelles.
🔊 Je peux répondre vocalement si le service est configuré.`,
      quoted, isVoice);
    return true;
  }

  if (command === '!id') {
    await envoyerReponse(jid, `🆔 Identifiant du chat :\n${jid}`, quoted, isVoice);
    return true;
  }

  if (['!createur', '!hbot2'].includes(command)) {
    await envoyerReponse(
      jid,
      `🤖 Je suis Hbot2.\n👤 J'ai été créé et développé par ${CREATOR_NAME}.`,
      quoted,
      isVoice
    );
    return true;
  }

  if (command === '!resetia') {
    conversations.delete(jid);
    await envoyerReponse(
      jid,
      '🧹 La conversation temporaire avec l’IA a été réinitialisée.',
      quoted,
      isVoice
    );
    return true;
  }

  if (command === '!memoire') {
    if (!isGroupJid(jid)) {
      await envoyerReponse(
        jid,
        'Cette commande concerne la mémoire des groupes WhatsApp.',
        quoted,
        isVoice
      );
      return true;
    }

    const memory = await recupererMemoireGroupe(jid, 30);

    const response = memory.length
      ? '🧠 *Dernières informations mémorisées :*\n\n' +
        memory.map((item, i) =>
          `${i + 1}. ${item.texte} (${item.dateISO || 'date inconnue'})`
        ).join('\n\n')
      : 'Aucune information mémorisée pour ce groupe.';

    await envoyerReponse(jid, response, quoted, isVoice);
    return true;
  }

  return false;
}

// ============================================================
// TRAITER UN MESSAGE ENTRANT
// ============================================================

async function traiterMessage(msg) {
  if (!msg?.message || msg.key?.fromMe) return;
  if (msg.key?.remoteJid === 'status@broadcast') return;

  const jid = msg.key?.remoteJid;
  if (!jid) return;

  // Éviter de traiter deux fois le même message.
  const messageId = msg.key?.id;
  const dedupeKey = messageId ? `${jid}:${messageId}` : null;

  if (dedupeKey && processingMessages.has(dedupeKey)) return;

  if (dedupeKey) processingMessages.add(dedupeKey);

  try {
    const isGroup = isGroupJid(jid);
    const audioMessage = extraireAudio(msg);
    const isVoice = Boolean(audioMessage);

    let question = extraireTexte(msg);

    // --------------------------------------------------------
    // TRANSCRIPTION VOCALE
    // --------------------------------------------------------

    if (isVoice) {
      if (!groq) {
        await envoyerReponse(
          jid,
          '⚠️ La reconnaissance vocale est indisponible pour le moment.',
          msg
        );
        return;
      }

      try {
        const audioBuffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: pino({ level: 'silent' }),
            reuploadRequest: sockInstance.updateMediaMessage
          }
        );

        question = await transcrireAudio(
          audioBuffer,
          audioMessage.mimetype || 'audio/ogg'
        );

        if (!question) {
          await envoyerReponse(
            jid,
            '🎙️ Je n’ai pas réussi à comprendre ton message vocal.',
            msg
          );
          return;
        }

        console.log(`🎙️ Vocal transcrit pour ${jid}`);
      } catch (error) {
        console.error('❌ Téléchargement vocal :', error.message);
        await envoyerReponse(
          jid,
          '⚠️ Je n’ai pas réussi à récupérer ton message vocal.',
          msg
        );
        return;
      }
    }

    question = String(question || '').trim();
    if (!question) return;

    // --------------------------------------------------------
    // OBSERVER LES MESSAGES DU GROUPE
    // --------------------------------------------------------

    if (isGroup && !hbot2EstMentionne(question)) {
      const important = await analyserInformation(question);

      if (important) {
        await memoriserGroupe(jid, question, getAuthorName(msg));
      }

      // Hbot2 n'intervient pas sans être appelé.
      return;
    }

    // --------------------------------------------------------
    // QUESTION ADRESSÉE À HBOT2
    // --------------------------------------------------------

    question = nettoyerQuestion(question);

    if (!question) question = 'Bonjour Hbot2';

    if (question.startsWith('!')) {
      const handled = await traiterCommande(jid, question, msg, isVoice);
      if (handled) return;
    }

    // --------------------------------------------------------
    // RÉCUPÉRER LA MÉMOIRE DU GROUPE
    // --------------------------------------------------------

    const groupMemory = isGroup
      ? await recupererMemoireGroupe(jid)
      : [];

    // --------------------------------------------------------
    // RECHERCHE INTERNET
    // --------------------------------------------------------

    let webData = null;

    if (await questionNecessiteWeb(question)) {
      if (TAVILY_API_KEY) {
        console.log(`🌐 Recherche Internet : ${question}`);
        webData = await rechercherInternet(question);
      } else {
        console.warn('⚠️ Question actuelle, mais TAVILY_API_KEY manquante');
      }
    }

    // --------------------------------------------------------
    // RÉPONSE IA
    // --------------------------------------------------------

    const answer = await genererIA(
      jid,
      question,
      groupMemory,
      webData
    );

    // Mémoriser une information nouvelle, si elle est importante.
    if (isGroup) {
      const important = await analyserInformation(question);

      if (important) {
        await memoriserGroupe(jid, question, getAuthorName(msg));
      }
    }

    // --------------------------------------------------------
    // RÉPONSE VOCALE OU TEXTE
    // --------------------------------------------------------

    await envoyerReponse(jid, answer, msg, isVoice);

  } catch (error) {
    console.error('❌ Erreur traitement message :', error);
  } finally {
    if (dedupeKey) processingMessages.delete(dedupeKey);
  }
}

// ============================================================
// CONNEXION WHATSAPP
// ============================================================

async function connecterWhatsApp() {
  if (reconnecting) return;

  reconnecting = true;
  const generation = ++connectionGeneration;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(
      'auth_info_baileys_hbot2'
    );

    const { version } = await fetchLatestBaileysVersion();

    console.log(`📱 Version Baileys : ${version.join('.')}`);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Hbot2', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false
    });

    sockInstance = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      if (generation !== connectionGeneration) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQrImage = await QRCode.toDataURL(qr);
          console.log('📲 QR disponible sur la page Render.');
        } catch (error) {
          console.error('❌ Génération QR :', error.message);
        }
      }

      if (connection === 'open') {
        isConnected = true;
        currentQrImage = null;
        reconnecting = false;

        console.log('====================================');
        console.log('🟢 HBOT2 CONNECTÉ À WHATSAPP');
        console.log(`👤 Créateur : ${CREATOR_NAME}`);
        console.log(`🧠 Groq : ${groq ? 'OK' : 'MANQUANT'}`);
        console.log(`🌐 Tavily : ${TAVILY_API_KEY ? 'OK' : 'MANQUANT'}`);
        console.log(`🔊 ElevenLabs : ${ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID ? 'OK' : 'MANQUANT'}`);
        console.log(`🔥 Firestore : ${db ? 'OK' : 'MANQUANT'}`);
        console.log('====================================');
      }

      if (connection === 'close') {
        isConnected = false;
        currentQrImage = null;

        const statusCode = new Boom(lastDisconnect?.error)
          .output?.statusCode;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`🔴 WhatsApp déconnecté. Code : ${statusCode}`);

        reconnecting = false;

        if (shouldReconnect) {
          console.log('🔄 Reconnexion dans 5 secondes...');
          setTimeout(() => {
            if (!reconnecting) connecterWhatsApp();
          }, 5000);
        } else {
          console.log('🚪 Session déconnectée. Une nouvelle association WhatsApp sera nécessaire.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        await traiterMessage(msg);
      }
    });

  } catch (error) {
    reconnecting = false;
    isConnected = false;

    console.error('❌ Connexion WhatsApp :', error.message);

    setTimeout(() => {
      if (!reconnecting) connecterWhatsApp();
    }, 5000);
  }
}

// ============================================================
// ARRÊT PROPRE
// ============================================================

process.on('unhandledRejection', error => {
  console.error('❌ Promesse non gérée :', error);
});

process.on('uncaughtException', error => {
  console.error('❌ Exception :', error);
});

// ============================================================
// DÉMARRAGE
// ============================================================

console.log('====================================');
console.log('🤖 DÉMARRAGE DE HBOT2');
console.log(`👤 Créateur : ${CREATOR_NAME}`);
console.log('🧠 Mémoire séparée par groupe');
console.log('🌐 Recherche Web disponible si configurée');
console.log('🎙️ Reconnaissance vocale disponible si configurée');
console.log('🔊 Réponse vocale disponible si configurée');
console.log('🚫 Aucun rappel automatique');
console.log('====================================');

connecterWhatsApp();
