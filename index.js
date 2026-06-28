const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ 
      version, 
      auth: state, 
      printQRInTerminal: true, 
      logger: pino({ level: 'silent' }),
      keepAliveIntervalMs: 30000 // <-- Empêche le crash
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
        const { connection, lastDisconnect } = u;
        if(connection === 'open') console.log('✅ BOT EN LIGNE - SCAN LE QR MAINTENANT');
        else if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut;
            console.log('❌ Déconnecté. Raison:', lastDisconnect.error, 'Reconnect:', shouldReconnect);
            if(shouldReconnect) startBot(); // <-- Se relance tout seul
        }
    });
}
startBot();
