const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const http = require('http');

http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);
console.log(`🌐 Serveur actif sur ${process.env.PORT || 3000}`);

let qrAffiché = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !qrAffiché) {
            qrAffiché = true;
            const lienQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            console.log('\n👉 LIEN QR: CLIQUE ICI =>', lienQR, '\n');
            console.log('👉 OU SCAN CE GROS QR:\n');
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Déconnecté. Raison:', lastDisconnect.error?.output?.statusCode);
            if (shouldReconnect) { qrAffiché = false; startBot(); } // On reset pour nouveau QR
        } else if (connection === 'open') {
            console.log('✅ Bot connecté !');
        }
    });
}
startBot();
