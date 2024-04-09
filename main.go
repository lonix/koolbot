package main

import (
	"database/sql"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/bwmarrin/discordgo"
	_ "github.com/mattn/go-sqlite3"
	"gopkg.in/yaml.v2"
)

// Config struct matches the structure of the YAML configuration file.
type Config struct {
	DiscordToken       string   `yaml:"discord_token"`
	DiscordGuildID     string   `yaml:"discord_guildID"`
	DiscordCoolRoleID  string   `yaml:"discord_coolRoleID"`
	DatabasePath       string   `yaml:"database_path"`
	ExcludedChannels   []string `yaml:"excluded_channels"`
	AdminOnlyChannelID string   `yaml:"admin_only_channelID"`
}

func loadConfig(configPath string) (*Config, error) {
	configFile, err := ioutil.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var config Config
	err = yaml.Unmarshal(configFile, &config)
	if err != nil {
		return nil, err
	}

	return &config, nil
}

func initDB(databasePath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", databasePath)
	if err != nil {
		return nil, err
	}

	// Your database initialization code here

	return db, nil
}

func registerSlashCommands(s *discordgo.Session, guildID string) error {
	pingCommand := &discordgo.ApplicationCommand{
		Name:        "ping",
		Description: "Responds with Pong!",
	}

	_, err := s.ApplicationCommandCreate(s.State.User.ID, guildID, pingCommand)
	if err != nil {
		return fmt.Errorf("cannot create slash command: %w", err)
	}

	return nil
}

func main() {
	config, err := loadConfig("config.yaml")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Set up logging
	logFile, err := os.OpenFile("koolbot.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0666)
	if err != nil {
		log.Fatalf("error opening log file: %v", err)
	}
	defer logFile.Close()
	log.SetOutput(logFile)
	log.SetPrefix("[koolbot] ")
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// Initialize database
	db, err := initDB(config.DatabasePath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	// Initialize Discord session
	dg, err := discordgo.New("Bot " + config.DiscordToken)
	if err != nil {
		log.Fatalf("error creating Discord session: %v", err)
	}
	defer dg.Close()

	// Register slash commands
	err = registerSlashCommands(dg, config.DiscordGuildID)
	if err != nil {
		log.Fatalf("failed to register slash commands: %v", err)
	}

	dg.AddHandler(func(s *discordgo.Session, i *discordgo.InteractionCreate) {
		if i.Type != discordgo.InteractionApplicationCommand {
			return
		}

		switch i.ApplicationCommandData().Name {
		case "ping":
			err := s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
				Type: discordgo.InteractionResponseChannelMessageWithSource,
				Data: &discordgo.InteractionResponseData{
					Content: "Pong!",
				},
			})
			if err != nil {
				log.Printf("Failed to respond to ping command: %v", err)
			}
		}
	})

	err = dg.Open()
	if err != nil {
		log.Fatalf("error opening connection to Discord: %v", err)
	}

	defer func() {
		_, err := dg.ChannelMessageSend(config.AdminOnlyChannelID, "Bot is shutting down.")
		if err != nil {
			log.Printf("Error sending shutdown message to admin channel: %v", err)
		}
		dg.Close()
	}()

	// Bot is now connected; send a message to the admin-only channel
	_, err = dg.ChannelMessageSend(config.AdminOnlyChannelID, "Bot is now online and available!")
	if err != nil {
		log.Printf("Error sending online message to admin channel: %v", err)
	}

	log.Println("Bot is now running. Press CTRL+C to exit.")
	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM, os.Interrupt, os.Kill)
	<-sc
}
