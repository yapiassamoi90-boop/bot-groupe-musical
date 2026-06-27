const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const from = msg.key.remoteJid;

        if (text.toLowerCase().includes('salut')) {
            await sock.sendMessage(from, { text: 'H-BOT V9 Présent Chef 🔥 Je t’entends.' });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            if((lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut) {
                console.log('Reconnexion...');
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Connexion: open ✅ Bot en ligne');
        }
    });
}
startBot();
