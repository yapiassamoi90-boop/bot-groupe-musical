const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ 
      version, 
      auth: state, 
      printQRInTerminal: true, // <-- ÇA AFFICHE LE QR
      logger: pino({ level: 'silent' }) 
    });

    // Sauvegarde la session pour ne plus scanner
    sock.ev.on('creds.update', saveCreds);
    
    // Quand le bot reçoit un message
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if ((msg.message.conversation || '').toLowerCase() === 'salut') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'H-BOT V9 Présent Chef 🔥' });
        }
    });

    // Quand le bot est connecté
    sock.ev.on('connection.update', (u) => {
        if(u.connection === 'open') console.log('✅ BOT EN LIGNE');
        else if(u.connection === 'close') console.log('❌ Déconnecté');
    });
}
startBot();
