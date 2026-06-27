const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' })
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Entre ton numéro WhatsApp avec +225: ');
        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
        console.log('CODE À ENTRER SUR WHATSAPP:', code); // <- C'EST ÇA QU'ON VEUT
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
        const { connection } = update;
        if(connection === 'open') console.log('Connexion: open ✅ Bot en ligne');
        if(connection === 'close') startBot();
    });
}
startBot();
