import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler
from supabase import create_client, Client

# --- CONFIGURATION ---
SUPABASE_URL = "https://ffzyhcczkyigvnbzzfxx.supabase.co"
SUPABASE_KEY = "sb_publishable__Fg6SatcKPzNJbUJbMfz_w_v8DGdLay" 
TELEGRAM_TOKEN = "8745910142:AAFjrFAvrREAW1Q47Aey-8zLHEepv1CDn2Y"

# Initialisation Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Configuration du logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(chat_id=update.effective_chat.id, text="Bot prêt ! Utilise /chantres pour voir la liste.")

async def afficher_membres(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Récupération des données dans Supabase
    response = supabase.table("membres").select("*").execute()
    membres = response.data

    if not membres:
        await context.bot.send_message(chat_id=update.effective_chat.id, text="Aucun membre trouvé.")
        return

    # Boucle d'envoi des membres
    for m in membres:
        # Construction de la légende
        caption = f"👤 {m['nom']}\n🎤 Rôle : {m['role']}"
        
        # Envoi direct de la photo avec la légende
        await context.bot.send_photo(
            chat_id=update.effective_chat.id, 
            photo=m['photo_url'], 
            caption=caption,
            parse_mode='Markdown'
        )

if __name__ == '__main__':
    application = ApplicationBuilder().token(TELEGRAM_TOKEN).build()
    
    application.add_handler(CommandHandler('start', start))
    application.add_handler(CommandHandler('chantres', afficher_membres))
    
    print("Bot en cours d'exécution...")
    application.run_polling()