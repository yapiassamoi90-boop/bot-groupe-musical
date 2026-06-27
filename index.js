const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true // <- C'EST ÇA QUI AFFICHE LE QR
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || '';
        const from = msg.key.remoteJid;
        if (text.toLowerCase().includes('salut')) {
            await sock.sendMessage(from, { text: 'H-BOT V9 Présent Chef 🔥 Je t’entends.' });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if(qr) console.log('SCANNE CE QR CODE CI-DESSUS 👆');
        if(connection === 'open') console.log('Connexion: open ✅ Bot en ligne');
        if(connection === 'close') {
            const statusCode = update.lastDisconnect.error?.output?.statusCode;
            if(statusCode!== DisconnectReason.loggedOut) startBot();
        }
    });
}
startBot();
