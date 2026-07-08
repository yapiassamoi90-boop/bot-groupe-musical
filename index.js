const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const tesseract = require('tesseract.js');
const pdf = require('pdf-parse');
const schedule = require('node-schedule');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock;
let ADMIN_ID = null;
const jours_fr = {"Monday": "Lundi", "Tuesday": "Mardi", "Wednesday": "Mercredi", "Thursday": "Jeudi", "Friday": "Vendredi", "Saturday": "Samedi", "Sunday": "Dimanche"};

async function sendReminder(jid, message) {
    try {
        await sock.sendMessage(jid, { text: message });
        if (ADMIN_ID) {
            const premiereLigne = message.split('\n')[0];
            await sock.sendMessage(ADMIN_ID, { text: `✅ RAPPEL ENVOYÉ AU GROUPE\n${premiereLigne}` });
        }
        console.log(`Rappel envoyé au groupe ${jid}`);
    } catch (e) { console.error(e); }
}

async function lireImage(buffer) {
    const { data: { text } } = await tesseract.recognize(buffer, 'fra');
    return text;
}

async function lirePdf(buffer) {
    const data = await pdf(buffer);
    return data.text;
}

function extraireProgramme(texte) {
    const programme = [];
    const lignes = texte.split('\n').map(l => l.trim()).filter(l => l);
    const regexNom = /[A-Za-zÀ-ÿ'\-]+/g;

    for (let i = 0; i < lignes.length; i++) {
        const ligne = lignes[i];
        const dateMatch = ligne.match(/(\d{2}\/\d{2}\/\d{2})/);
        if (dateMatch) {
            const dateStr = dateMatch[1];
            let reste = ligne.replace(dateStr, '');
            let mots = reste.match(regexNom) || [];

            if (mots.length < 3 && i + 1 < lignes.length) {
                const suivante = lignes[i + 1];
                mots = mots.concat(suivante.match(regexNom) || []);
            }
            if (mots.length >= 3) {
                programme.push([dateStr, [mots[0], mots[1], mots[2]]]);
            }
        }
    }
    return programme;
}

async function programerRappels(groupeId, programme) {
    for (const [dateStr, noms] of programme) {
        try {
            const [j, m, a] = dateStr.split('/');
            const dtDimanche = new Date(2000 + parseInt(a), parseInt(m) - 1, parseInt(j));
            
            const dtVendredi = new Date(dtDimanche); 
            dtVendredi.setDate(dtDimanche.getDate() - 2);
            dtVendredi.setHours(18, 0, 0, 0);

            const dtSamedi = new Date(dtDimanche); 
            dtSamedi.setDate(dtDimanche.getDate() - 1);
            dtSamedi.setHours(14, 0, 0, 0);

            // Noms complets écrits en entier
            const nomsStr = `Adoration: ${noms[0]}\nCélébration: ${noms[1]}\nOffrande: ${noms[2]}`;

            if (schedule.scheduledJobs[`v_${groupeId}_${dateStr}`]) schedule.cancelJob(`v_${groupeId}_${dateStr}`);
            if (schedule.scheduledJobs[`s_${groupeId}_${dateStr}`]) schedule.cancelJob(`s_${groupeId}_${dateStr}`);

            schedule.scheduleJob(`v_${groupeId}_${dateStr}`, dtVendredi, () => {
                sendReminder(groupeId, `🔔 RAPPEL GROUPE: Répétition demain Samedi à 16h.\n\nProgramme Dimanche ${dateStr}:\n${nomsStr}`);
            });

            schedule.scheduleJob(`s_${groupeId}_${dateStr}`, dtSamedi, () => {
                sendReminder(groupeId, `🔔 RAPPEL: Répétition AUJOURD'HUI à 16h.\n\nN'oubliez pas:\n${nomsStr}\nSoyez à l'heure!`);
            });
        } catch (e) { console.error("Date invalide", dateStr); }
    }
}

async function afficherListeDetails(recipientJid) {
    const jobs = schedule.scheduledJobs;
    const activeJobs = Object.keys(jobs).filter(name => name.includes('_'));
    
    if (activeJobs.length === 0) {
        await sock.sendMessage(recipientJid, { text: "❌ Aucun rappel programmé pour l'instant." });
        return;
    }

    let reponse = "📅 *RAPPELS & NOMS PROGRAMMÉS:*\n\n";
    for (const jobName of activeJobs) {
        const date = jobs[jobName].nextInvocation();
        if (!date) continue;
        const jourEn = date.toLocaleString('en-US', { weekday: 'long' });
        const jourFr = jours_fr[jourEn] || jourEn;
        const heureStr = date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        
        reponse += `• *${jourFr} ${heureStr}*\nJob: ${jobName}\n\n`;
    }
    await sock.sendMessage(recipientJid, { text: reponse });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({ 
        logger: pino({ level: 'silent' }), 
        auth: state 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            console.log("=== SCANNE CE QR CODE ===");
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('✅ Bot WhatsApp connecté et en ligne...');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!ADMIN_ID) {
            const { data } = await supabase.from('config_bot').select('user_id').single();
            if (data) ADMIN_ID = data.user_id;
        }

        if (text === '.getid') {
            await sock.sendMessage(from, { text: `✅ ID du groupe:\n${from}\n\nCopie et envoie-le moi en PV avec .setgroupe <ID>` });
        }

        if (text.startsWith('.setgroupe') && from.endsWith('@s.whatsapp.net')) {
            const parts = text.split(' ');
            const groupeId = parts[1];
            ADMIN_ID = from;
            await supabase.from('config_bot').upsert({ user_id: ADMIN_ID, group_id: groupeId });
            await sock.sendMessage(from, { text: '✅ Groupe enregistré!\n\nMaintenant envoie-moi la photo ou le PDF du programme.' });
        }

        if (text === '.liste' && from === ADMIN_ID) {
            await afficherListeDetails(from);
        }

        if (msg.message.imageMessage || msg.message.documentMessage) {
            if (!ADMIN_ID) return sock.sendMessage(from, { text: '❌ Fais .setgroupe en PV d\'abord' });
            const { data } = await supabase.from('config_bot').select('group_id').eq('user_id', ADMIN_ID).single();
            if (!data) return sock.sendMessage(from, { text: '❌ Groupe non configuré' });

            await sock.sendMessage(from, { text: '⏳ Je lis le programme...' });
            
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const texte = msg.message.imageMessage ? await lireImage(buffer) : await lirePdf(buffer);

                const programme = extraireProgramme(texte);
                if (programme.length === 0) return sock.sendMessage(from, { text: '❌ Je n\'ai rien trouvé. Vérifie l\'image ou le fichier.' });

                await programerRappels(data.group_id, programme);
                await sock.sendMessage(from, { text: `✅ Tous les rappels sont programmés (${programme.length} dimanches) ! Voici le récapitulatif :` });
                await afficherListeDetails(from);
            } catch (err) {
                console.error("Erreur traitement média:", err);
                await sock.sendMessage(from, { text: '❌ Erreur lors du téléchargement ou de la lecture du fichier.' });
            }
        }
    });
}

startBot();
