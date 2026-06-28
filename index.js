const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode-terminal'); // <-- NOUVEAU

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('BOT OK')).listen(PORT, () => console.log(`🌐 Serveur actif sur ${PORT}`));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ 
      version, 
      auth: state, 
      printQRInTerminal: false, // <-- ON DESACTIVE LUI
      logger: pino({ level: 'silent' }),
      keepAliveIntervalMs: 30000 
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if(qr) {
            console.log('👉 SCAN CE QR MAINTENANT AVANT 60s 👈');
            qrcode.generate(qr, { small: true }); // <-- ON AFFICHE LE QR ICI
        }
        if(connection === 'open') console.log('✅ BOT EN LIGNE');
        else if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut;
            console.log('❌ Déconnecté. Code:', lastDisconnect.error?.output?.statusCode);
            if(shouldReconnect) startBot();
        }
    });
}
startBot();
