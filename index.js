// Charger les variables d'environnement depuis le fichier .env
require('dotenv').config();

const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// Initialisation de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function startBot() {
    // Gestion de l'authentification (dossier 'auth_info' sera créé automatiquement)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({ 
        logger: pino({ level: 'silent' }), 
        auth: state,
        printQRInTerminal: false 
    });

    // Gestion de la connexion et affichage du QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            console.log("--- SCANNEZ LE QR CODE AVEC VOTRE WHATSAPP ---");
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            console.log("Connexion fermée, tentative de reconnexion...");
            startBot(); 
        } else if (connection === 'open') {
            console.log("✅ Bot WhatsApp connecté avec succès !");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Boucle de vérification des programmes (Scan toutes les 60 secondes)
    setInterval(async () => {
        const { data: programmes, error } = await supabase
            .from('programmes')
            .select('*')
            .eq('actif', true);

        if (error) {
            console.error("Erreur lors de la lecture Supabase :", error);
            return;
        }

        const now = new Date();
        const heureActuelle = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const dateActuelle = now.toLocaleDateString('fr-FR');

        for (const p of programmes) {
            // Comparaison des dates et heures
            if (p.heure === heureActuelle && p.date_complete === dateActuelle) {
                const msg = `🔔 PROGRAMME: ${p.chantre}\n\n${p.texte}`;
                
                try {
                    // Envoi du message WhatsApp
                    await sock.sendMessage(p.chat_id + '@s.whatsapp.net', { text: msg });
                    
                    // Marquer le programme comme désactivé dans Supabase après envoi
                    await supabase.from('programmes').update({ actif: false }).eq('id', p.id);
                    
                    console.log(`✅ Message envoyé sur WhatsApp à : ${p.chantre}`);
                } catch (err) {
                    console.error("❌ Erreur lors de l'envoi WhatsApp :", err);
                }
            }
        }
    }, 60000); 
}

startBot();