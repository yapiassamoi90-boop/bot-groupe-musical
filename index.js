require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/ba' + 'ileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({ 
        logger: pino({ level: 'silent' }), 
        auth: state,
        browser: ['Bot Musical', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            console.log("--- SCANNEZ LE QR CODE CI-DESSOUS ---");
            qrcode.generate(qr, { small: true }); 
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("Connexion fermée, tentative de reconnexion dans 5 secondes...");
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'open') {
            console.log("✅ Bot WhatsApp connecté avec succès !");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    setInterval(async () => {
        const { data: programmes } = await supabase.from('programmes').select('*').eq('actif', true);
        if (!programmes || programmes.length === 0) return;

        const now = new Date();
        const heureActuelle = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });
        const dateActuelle = now.toLocaleDateString('fr-FR');

        for (const p of programmes) {
            if (p.heure === heureActuelle && p.date_complete === dateActuelle) {
                try {
                    await sock.sendMessage(p.chat_id + '@s.whatsapp.net', { text: `🔔 ${p.chantre}\n\n${p.texte}` });
                    await supabase.from('programmes').update({ actif: false }).eq('id', p.id);
                    console.log(`✅ Message envoyé : ${p.chantre}`);
                } catch (err) {
                    console.error("Erreur lors de l'envoi :", err);
                }
            }
        }
    }, 60000); 
}

startBot();
