const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const http = require('http');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
http.createServer((req, res) => res.end('Bot OK')).listen(process.env.PORT || 3000);
let qrAffiché = false;

// V29 : Auth Supabase 100% Baileys Compatible
const useSupabaseAuthState = async (supabase, table, id) => {
    const writeData = async (data, key) => {
        await supabase.from(table).upsert({ session_id: id, key, value: data }, { onConflict: 'session_id,key' });
    };
    const readData = async (key) => {
        const { data } = await supabase.from(table).select('value').eq('session_id', id).eq('key', key).single();
        return data?.value;
    };

    let creds = await readData('creds') || initAuthCreds();
    
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) { value = proto.Message.AppStateSyncKeyData.fromObject(value); }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) { tasks.push(writeData(value, `${category}-${id}`)); }
                        }
                    }
                    await Promise.all(tasks);
                }
            },
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

async function startBot() {
    const { state, saveCreds } = await useSupabaseAuthState(supabase, 'whatsapp_sessions', 'mon_bot_id');
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr &&!qrAffiché) {
            qrAffiché = true;
            const lienQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            console.log('\n👉 LIEN QR: =>', lienQR, '\n');
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut;
            if (shouldReconnect) { qrAffiché = false; startBot(); }
        } else if (connection === 'open') {
            console.log('✅ Bot connecté + Session Supabase OK!');
        }
    });
}
startBot();
