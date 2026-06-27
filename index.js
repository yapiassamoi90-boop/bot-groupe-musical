const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const PHONE_NUMBER = process.env.PHONE_NUMBER; // <- Il prend le numéro sur Railway

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' })
    });

    if (!sock.authState.creds.registered && PHONE_NUMBER) {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('====================================');
        console.log('CODE À ENTRER SUR WHATSAPP:', code); // <- LE CODE SERA ICI
        console.log('====================================');
    }

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
        if(update.connection === 'open') console.log('Connexion: open ✅ Bot en ligne');
        if(update.connection === 'close') startBot();
    });
}
startBot();
