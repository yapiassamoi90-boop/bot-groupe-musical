const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const PHONE_NUMBER = process.env.PHONE_NUMBER?.trim();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
   const sock = makeWASocket({ 
  version, 
  auth: state, 
  printQRInTerminal: true, // <--- C’EST ÇA LE TRUC
  logger: pino({ level: 'silent' }) 
});
    if (!state.creds.registered) {
        console.log('Attente 5s avant de demander le code...');
        await new Promise(r => setTimeout(r, 5000));
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log(`\n\n<<<<<< CODE WHATSAPP: ${code} >>>>>>`);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if ((msg.message.conversation || '').toLowerCase() === 'salut') {
            await sock.sendMessage(msg.key.remoteJid, { text: 'H-BOT V9 Présent Chef 🔥' });
        }
    });
    sock.ev.on('connection.update', (u) => {
        if(u.connection === 'open') console.log('✅ BOT EN LIGNE');
    });
}
startBot();
