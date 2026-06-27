const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const PHONE_NUMBER = process.env.PHONE_NUMBER?.trim();
const authDir = './auth_info_baileys';

// ON SUPPRIME TOUT À CHAQUE DÉMARRAGE POUR FORCER LE CODE
if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log('Ancienne session supprimée. Demande nouveau code...');
}

async function startBot() {
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'debug' }) });

    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log(`\n\n!!!!!!!!!!!!!!!!!!!! CODE: ${code}!!!!!!!!!!!!!!!!!!!!\n\n`);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if ((msg.message.conversation || '').toLowerCase() === 'salut') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'H-BOT V9 Présent Chef 🔥' });
        }
    });
    sock.ev.on('connection.update', (u) => {
        if(u.connection === 'open') console.log('✅ BOT EN LIGNE');
    });
}
startBot();
