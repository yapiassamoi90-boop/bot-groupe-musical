require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/ba' + 'ileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({ 
        logger: pino({ level: 'silent' }), 
        auth: state,
        browser: ['Bot Musical', 'Chrome', '1.0.0']
    });

    // --- MISE À JOUR : CODE D'APPAIRAGE ---
    if (!sock.authState.creds.me) {
        const phoneNumber = process.env.WHATSAPP_NUMBER; // Mettez votre numéro dans les variables Railway
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`--- VOTRE CODE D'APPAIRAGE EST : ${code} ---`);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log("✅ Bot WhatsApp connecté avec succès !");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Boucle de vérification
    setInterval(async () => {
        const { data: programmes } = await supabase.from('programmes').select('*').eq('actif', true);
        if (!programmes) return;

        const now = new Date();
        const heureActuelle = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateActuelle = now.toLocaleDateString('fr-FR');

        for (const p of programmes) {
            if (p.heure === heureActuelle && p.date_complete === dateActuelle) {
                await sock.sendMessage(p.chat_id + '@s.whatsapp.net', { text: `🔔 ${p.chantre}\n\n${p.texte}` });
                await supabase.from('programmes').update({ actif: false }).eq('id', p.id);
            }
        }
    }, 60000); 
}

startBot();
