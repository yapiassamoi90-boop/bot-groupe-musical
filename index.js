const { default: makeWASocket, DisconnectReason, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const http = require('http');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);
let qrAffiché = false;

// V32 : Adaptateur Supabase Complet
const useSupabaseAuthState = async (supabase, table, id) => {
    const write = async (key, value) => {
        await supabase.from(table).upsert({ key: `${id}-${key}`, value }, { onConflict: 'key' });
    };
    const read = async (key) => {
        const { data } = await supabase.from(table).select('value').eq('key', `${id}-${key}`).single();
        return data?.value;
    };

    const creds = await read('creds') || initAuthCreds();
    
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (i) => { data[i] = await read(`${type}-${i}`); }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) for (const id in data[category])
                        if (data[category][id]) tasks.push(write(`${category}-${id}`, data[category][id]));
                    await Promise.all(tasks);
                }
            },
        },
        saveCreds: () => write('creds', creds)
    };
};

async function startBot() {
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_sessions', 'bot1');
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
        if (u.qr &&!qrAffiché) { qrAffiché = true; console.log('QR => https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(u.qr)); }
        if (u.connection === 'close') { if (u.lastDisconnect.error?.output?.statusCode!== DisconnectReason.loggedOut) { qrAffiché = false; startBot(); }
        } else if (u.connection === 'open') { console.log('✅ Bot connecté Supabase!'); }
    });
}
startBot();
