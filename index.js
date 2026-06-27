require('dotenv').config();
const fs = require('fs');
if(process.env.AUTH_JSON && !fs.existsSync('./auth_info_baileys')){
    fs.mkdirSync('./auth_info_baileys');
    fs.writeFileSync('./auth_info_baileys/creds.json', process.env.AUTH_JSON);
}
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if(qr) qrcode.generate(qr, {small: true});
        if(connection === 'open') console.log('✅ H-BOT V9 CONNECTÉ');
        if(connection === 'close') {
            if(lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startBot();
            }
        }
    });

    console.log('H-BOT V9 en attente du QR Code...');
}

startBot();
