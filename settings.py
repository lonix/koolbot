import os
import logging
import pathlib
from dotenv import load_dotenv
from logging.config import dictConfig
load_dotenv()

DISCORD_API_TOKEN = os.getenv('DISCORD_API_TOKEN')
DISCORD_CHANNEL_ID = os.getenv('DISCORD_CHANNEL_ID')

BASE_DIR = pathlib.Path(__file__).parent
CMDS_DIR = BASE_DIR / "cmds"

LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
      "verbose":{
        "format" : "%(levelname)-10s - %(asctime)s - %(module)-15s : %(message)s"
      },
      "standard":{
        "format" : "%(levelname)-10s - %(name)-15s : %(message)s"
      }
    },
    "handlers": {
        "console": {
          "level": "DEBUG",
          "class": "logging.StreamHandler",
          "formatter": "standard"
        },
        "console2": {
          "level": "WARNING",
          "class": "logging.StreamHandler",
          "formatter": "standard"
      },
      "file": {
        "level": "INFO",
        "class": "logging.FileHandler",
        "filename": "logs/infos.log",
        "formatter": "verbose",
        "mode": "w"
      }
    },
    "loggers": {
        "bot": {
          "handlers": ["console"],
          "level" : "INFO",
          "propagate": False
        },
        "discord" : {
          "handlers": ["console2", "file"],
          "level" : "INFO",
          "propagate": False
        }
    }
}
dictConfig(LOGGING_CONFIG)
