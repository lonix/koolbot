package main

import (
	"database/sql"
	"io/ioutil"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

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

var (
	voiceStateMap = make(map[string]time.Time)
	db            *sql.DB
)

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
	return db, nil
}

func updateUserVoiceTime(db *sql.DB, userID string, seconds int) {
	_, err := db.Exec("INSERT INTO users (user_id, total_seconds, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET total_seconds = total_seconds + EXCLUDED.total_seconds, last_seen = CURRENT_TIMESTAMP", userID, seconds)
	if err != nil {
		log.Printf("Failed to update user voice time: %v", err)
	}
}

func main() {
	config, err := loadConfig("config.yaml")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	db, err = initDB(config.DatabasePath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	dg, err := discordgo.New("Bot " + config.DiscordToken)
	if err != nil {
		log.Fatalf("error creating Discord session: %v", err)
	}
	defer dg.Close()

	dg.AddHandler(func(s *discordgo.Session, vsu *discordgo.VoiceStateUpdate) {
		userID := vsu.UserID
		now := time.Now()

		// User joins a voice channel
		if vsu.ChannelID != "" {
			voiceStateMap[userID] = now
			return
		}

		// User leaves a voice channel
		if joinTime, ok := voiceStateMap[userID]; ok {
			duration := int(now.Sub(joinTime).Seconds())
			updateUserVoiceTime(db, userID, duration)
			delete(voiceStateMap, userID)
		}
	})

	err = dg.Open()
	if err != nil {
		log.Fatalf("error opening connection to Discord: %v", err)
	}

	log.Println("Bot is now running. Press CTRL+C to exit.")
	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM, os.Interrupt, os.Kill)
	<-sc
}
