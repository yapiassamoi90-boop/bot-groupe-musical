const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode-terminal');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

http.createServer((req, res) => res.end('Bot actif')).listen(process.env.PORT || 3000);

async function useSupabaseAuthState(supabase, tableName) {
    const read = async (key) => {
        const { data } = await supabase.from(tableName).select('value').eq('key', key).single();
        return data ? data.value : null;
    };
    const write = async (key, value) => {
        await supabase.from(tableName).upsert({ key, value });
    };

    const creds = (await read('creds')) || { noiseKey: null }; // Force une structure si vide
    return {
        state: { creds, keys: {} },
        saveCreds: () => write('creds', creds)
    };
}

async function startBot() {
    console.log("🔄 Démarrage du bot...");
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_sessions');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("SCANNE CE QR CODE : ");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(startBot, 5000); // Attend 5 secondes avant de réessayer
            }
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp connecté avec succès via Supabase !');
        }
    });
}

startBot();
