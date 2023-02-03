import settings
import discord
from discord.ext import commands

logger = settings.logging.getLogger("bot")

def run():
    intents = discord.Intents.all()
    bot = commands.Bot(command_prefix="!", intents=intents)

    @bot.event
    async def on_ready():
        logger.info(f"User: {bot.user.name} (ID: {bot.user.id})")
        for cmd_file in settings.CMDS_DIR.glob("*.py"):
            if cmd_file.name != "__init__.py":
              await bot.load_extension(f"cmds.{cmd_file.name[:-3]}")
              cmd_name = cmd_file.name[:-3]
              logger.info(f"Loading command: {cmd_name}")




    bot.run(settings.DISCORD_API_TOKEN, root_logger=True)

if __name__ == "__main__":
    run()
