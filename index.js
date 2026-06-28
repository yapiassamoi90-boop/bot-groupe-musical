const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const http = require('http');

// Faux serveur pour Railway
http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);
console.log(`🌐 Serveur actif sur ${process.env.PORT || 3000}`);

let qrAffiché = false; // <- NOUVEAU : On affiche le QR 1 seule fois

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // On gère nous-même
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !qrAffiché) { // <- On affiche 1 seule fois
            qrAffiché = true;
            console.log('\n👉 SCAN CE QR MAINTENANT AVEC WHATSAPP\n');
            qrcode.generate(qr, { small: false }); // GROS QR
            console.log('\nTU AS 2 MINUTES POUR SCANNER\n');
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Déconnecté. Raison:', lastDisconnect.error?.output?.statusCode);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot connecté !');
        }
    });
}

startBot();
