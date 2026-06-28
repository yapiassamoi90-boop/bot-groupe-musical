const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const http = require('http');

// Initialisation Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);

let qrAffiché = false;

// Fonction simplifiée pour persister dans Supabase
async function useSupabaseAuthState(supabase, table, sessionId) {
    const writeData = async (data, key) => {
        await supabase.from(table).upsert({ session_id: sessionId, key: key, value: data });
    };

    const readData = async (key) => {
        const { data } = await supabase.from(table).select('value').eq('session_id', sessionId).eq('key', key).single();
        return data ? data.value : null;
    };

    return {
        state: {
            creds: await readData('creds') || { /* initialiser les creds ici */ },
            keys: { get: async (type, ids) => { /* logique de lecture des clés */ return {}; } }
        },
        saveCreds: () => writeData(state.creds, 'creds')
    };
}

async function startBot() {
    // Utilisation de la nouvelle logique au lieu du dossier local 'session'
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_sessions', 'mon_bot_id');
    
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !qrAffiché) {
            qrAffiché = true;
            const lienQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            console.log('\n👉 LIEN QR: CLIQUE ICI =>', lienQR, '\n');
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) { 
                qrAffiché = false; 
                startBot(); 
            }
        } else if (connection === 'open') {
            console.log('✅ Bot connecté et session sauvegardée dans Supabase !');
        }
    });
}
startBot();
