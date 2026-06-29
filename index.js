const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const http = require('http');

// Configuration Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Serveur HTTP pour garder le service Railway actif
http.createServer((req, res) => res.end('Bot actif')).listen(process.env.PORT || 3000);

// Adaptateur pour stocker la session dans Supabase
async function useSupabaseAuthState(supabase, tableName) {
    const read = async (key) => {
        const { data } = await supabase.from(tableName).select('value').eq('key', key).single();
        return data ? data.value : null;
    };
    const write = async (key, value) => {
        await supabase.from(tableName).upsert({ key, value });
    };

    const creds = (await read('creds')) || {};
    return {
        state: { creds, keys: {} },
        saveCreds: () => write('creds', creds)
    };
}

async function startBot() {
    console.log("🔄 Démarrage du bot...");
    
    // Utilisation de la table 'whatsapp_sessions' créée dans Supabase
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_sessions');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Connexion fermée, reconnexion en cours...');
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp connecté avec succès via Supabase !');
        }
    });
}

startBot();
