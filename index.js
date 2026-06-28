const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http'); // <-- POUR RAILWAY

const PORT = process.env.PORT || 3000; // <-- Railway donne un PORT

// 1. FAKE SERVER pour Railway
http.createServer((req, res) => res.end('BOT OK')).listen(PORT, () => console.log(`🌐 Serveur actif sur ${PORT}`));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ 
      version, 
      auth: state, 
      printQRInTerminal: true, 
      qrTimeout: 60000, // <-- 60 secondes pour scanner
      logger: pino({ level: 'silent' }),
      keepAliveIntervalMs: 30000 
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if ((msg.message.conversation || '').toLowerCase() === 'salut') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'H-BOT V9 Présent Chef 🔥' });
        }
    });

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if(qr) console.log('👉 SCAN CE QR MAINTENANT AVANT 60s 👈');
        if(connection === 'open') console.log('✅ BOT EN LIGNE');
        else if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut;
            console.log('❌ Déconnecté. Raison:', lastDisconnect.error?.output?.statusCode);
            if(shouldReconnect) startBot();
        }
    });
}
startBot();
