import os
from dotenv import load_dotenv

load_dotenv()

DISCORD_API_SECRET = os.getenv('DISCORD_API_SECRET')
DISCORD_CHANNEL_ID = os.getenv('DISCORD_CHANNEL_ID')
