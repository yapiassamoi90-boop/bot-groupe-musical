const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal'); // <- Ajouté
const pino = require('pino');
const http = require('http'); // <- Ajouté pour Railway

http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000); // <- Obligatoire

let qrAffiché = false; // <- Pour 1 seul QR

async function startBot() {
    // On remet 'session' au lieu de '/app/session'
    const { state, saveCreds } = await useMultiFileAuthState('session'); 

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // <- On gère nous même
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !qrAffiché) { // <- 1 seul QR
            qrAffiché = true;
            const lienQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            console.log('\n👉 LIEN QR: CLIQUE ICI =>', lienQR, '\n');
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) { qrAffiché = false; startBot(); }
        } else if (connection === 'open') {
            console.log('✅ Bot connecté !');
        }
    });
}

startBot();
