# KoolBot

A feature-rich Discord bot built with TypeScript, featuring voice channel management, tracking, utility commands, and automated data cleanup. Designed for seamless deployment using Docker Compose.

![Discord.js](https://img.shields.io/badge/Discord.js-14.22.1-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9.2-blue)
![MongoDB](https://img.shields.io/badge/MongoDB-8.18.0-green)
![Docker](https://img.shields.io/badge/Docker-22.0.0-blue)

## 🚀 Quick Start with Docker Compose

The recommended way to run KoolBot is using Docker Compose, which handles all dependencies and configuration automatically.

### Prerequisites
- Docker and Docker Compose installed
- Discord Bot Token
- Discord Application ID and Guild ID

### 1. Clone and Configure
```bash
git clone <repository-url>
cd koolbot
cp .env.example .env
```

### 2. Edit Environment Variables
```bash
# Edit .env file with your Discord bot credentials
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_guild_id_here
MONGODB_URI=mongodb://mongodb:27017/koolbot
```

### 3. Start the Bot
```bash
# Production deployment
docker-compose up -d

# Development with hot reloading
docker-compose -f docker-compose.dev.yml up --build
```

That's it! Your bot is now running with MongoDB automatically configured and commands automatically registered with Discord.

## 🏗️ Architecture

KoolBot is built with a modular, service-oriented architecture:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Discord.js    │    │   TypeScript     │    │     MongoDB     │
│   Bot Client    │◄──►│   Core Services  │◄──►│   Data Store    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Command       │    │   Voice Channel  │    │   Configuration │
│   System        │    │   Management     │    │   Service       │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## ✨ Features

### 🎙️ Voice Channel Management
- **Dynamic Channel Creation**: Users create voice channels from lobby
- **Automatic Ownership Transfer**: Seamless channel handoff when owners leave
- **Smart Cleanup**: Automatic channel removal and cleanup
- **Permission Management**: Role-based access control

### 📊 Voice Channel Tracking
- **Real-time Monitoring**: Track user activity in voice channels
- **Statistics Generation**: Weekly/monthly/all-time leaderboards
- **Session Recording**: Detailed session tracking with timestamps
- **Exclusion Support**: Configure channels to ignore

### 🧹 Data Cleanup System
- **Automatic Maintenance**: Configurable retention periods
- **Data Aggregation**: Preserve statistics while removing old sessions
- **Notification System**: Report cleanup activities to Discord channels
- **Admin Controls**: Manual cleanup execution and monitoring

### 🛠️ Utility Commands
- **Role Verification**: Role-based command access control
- **EVE Online Integration**: PLEX price checking
- **Quote Management**: Add, view, and manage quotes
- **Bot Statistics**: Monitor bot performance and usage

### ⚙️ Configuration Management
- **Dynamic Settings**: Runtime configuration updates
- **Hierarchical Organization**: Dot-notation configuration keys
- **Validation**: Schema-based configuration validation
- **Migration Support**: Automatic settings migration

## 📋 Commands

### User Commands
| Command | Description | Permission |
|---------|-------------|------------|
| `/ping` | Basic connectivity test | All users |
| `/amikool` | Role-based verification | All users |
| `/plexprice` | EVE Online PLEX prices | All users |
| `/vctop` | Voice channel leaderboards | All users |
| `/vcstats` | Personal voice statistics | All users |
| `/seen` | Last seen information | All users |
| `/transfer-ownership` | Transfer channel ownership | Channel owner |
| `/quote` | Quote management | All users |
| `/setup-lobby` | Configure voice lobby | Admin |
| `/exclude-channel` | Exclude from tracking | Admin |
| `/config` | Configuration management | Admin |

### Admin Commands
| Command | Description | Permission |
|---------|-------------|------------|
| `/announce-vc-stats` | Trigger voice stats announcement | Admin |
| `/vc-cleanup` | Voice tracking cleanup management | Admin |
| `/botstats` | Bot performance statistics | Admin |

## 🐳 Docker Deployment

### Production Deployment
```yaml
# docker-compose.yml
services:
  bot:
    image: ghcr.io/lonix/koolbot:latest
    container_name: koolbot
    restart: unless-stopped
    env_file: .env
    depends_on:
      - mongodb
    stop_grace_period: 30s
    stop_signal: SIGTERM

  mongodb:
    image: mongo:latest
    container_name: koolbot-mongodb
    restart: unless-stopped
    volumes:
      - mongodb_data:/data/db
    ports:
      - "27017:27017"
    stop_grace_period: 30s
    stop_signal: SIGTERM

volumes:
  mongodb_data:
```

### Development Deployment
```yaml
# docker-compose.dev.yml
services:
  koolbot:
    build:
      context: .
      dockerfile: Dockerfile.dev
    container_name: koolbot-dev
    volumes:
      - .:/app
      - /app/node_modules
    env_file:
      - .env
    networks:
      - koolbot-network
    depends_on:
      - mongodb
    stop_grace_period: 30s
    stop_signal: SIGTERM

  mongodb:
    image: mongo:latest
    container_name: koolbot-mongodb-dev
    restart: unless-stopped
    volumes:
      - mongodb_data_dev:/data/db
    ports:
      - "27017:27017"
    networks:
      - koolbot-network
    stop_grace_period: 30s
    stop_signal: SIGTERM

volumes:
  mongodb_data_dev:

networks:
  koolbot-network:
    driver: bridge
```

### Docker Commands
```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f bot

# Stop services
docker-compose down

# Rebuild and restart
docker-compose up --build -d

# Access bot container
docker-compose exec bot sh
```

## ⚙️ Configuration

### Environment Variables (.env)
```bash
# Critical Bot Configuration (Required)
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_guild_id_here
MONGODB_URI=mongodb://mongodb:27017/koolbot
DEBUG=false
NODE_ENV=production
```

### Discord Logging Configuration
The bot can log important events to Discord channels using the `core.*` configuration structure:

```bash
# Enable startup/shutdown logging to #bot-status channel
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:123456789

# Enable error logging to #admin-alerts channel  
/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:987654321

# Enable cleanup logging to #bot-logs channel
/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:555666777

# Enable configuration change logging
/config set key:core.config.enabled value:true
/config set key:core.config.channel_id value:111222333

# Enable cron job logging
/config set key:core.cron.enabled value:true
/config set key:core.cron.channel_id value:444555666
```

**Available Log Types:**
- **`core.startup.*`** - Bot startup/shutdown, service initialization, Discord registration
- **`core.errors.*`** - Critical errors and problems that need admin attention
- **`core.cleanup.*`** - Voice channel cleanup results and status
- **`core.config.*`** - Configuration reloads and changes
- **`core.cron.*`** - Scheduled task execution results

### Database Configuration
All bot settings are stored in MongoDB and can be configured using the `/config` command:

```bash
# List all settings
/config list

# Get specific setting
/config get key:ping.enabled

# Set setting value
/config set key:ping.enabled value:false

# Reset to default
/config reset key:ping.enabled

# Reload commands after changes
/config reload
```

### Configuration Categories
- **Command Enablement**: Control which commands are available
- **Voice Channel Settings**: Lobby configuration and channel management
- **Voice Tracking**: Tracking features and exclusions
- **Announcements**: Schedule and channel configuration
- **Quote System**: Cooldowns and role permissions

## 🔧 Development

### Prerequisites
- Node.js 22+
- Docker and Docker Compose
- MongoDB (handled by Docker)

### Local Development Setup
```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start development server
npm run dev

# Run quality checks
npm run check
```

### Available Scripts
```bash
npm run build          # TypeScript compilation
npm run start          # Start production bot
npm run dev            # Start development server
npm run lint           # ESLint code quality check
npm run format         # Prettier code formatting
npm run check          # Full build, lint, and format check
```

### Code Quality
- **TypeScript**: Full type safety and modern JavaScript features
- **ESLint**: Code quality and style enforcement
- **Prettier**: Consistent code formatting
- **Error Handling**: Comprehensive error handling and logging
- **Testing**: Built-in validation and testing scripts

## 📊 Database Schema

### Voice Channel Tracking
```typescript
interface IVoiceChannelTracking {
  userId: string;
  username: string;
  totalTime: number; // in seconds
  lastSeen: Date;
  sessions: Array<{
    startTime: Date;
    endTime?: Date;
    duration?: number;
    channelId: string;
    channelName: string;
  }>;
  excludedChannels: string[];
  lastCleanupDate?: Date;
  monthlyTotals?: Array<{
    month: string;
    totalTime: number;
    sessionCount: number;
    channels: string[];
    averageSessionLength: number;
  }>;
}
```

### Configuration Storage
```typescript
interface IConfig {
  key: string;
  value: any;
  category: string;
  description: string;
  defaultValue: any;
  updatedAt: Date;
}
```

## 🚨 Troubleshooting

### Common Issues
1. **Bot not responding**: Check Discord permissions and token validity
2. **Database connection errors**: Verify MongoDB container is running
3. **Command registration failures**: Ensure bot has proper Discord permissions
4. **Voice tracking issues**: Check channel permissions and bot voice state

### Debug Mode
```bash
# Enable debug logging
DEBUG=true
```

### Logs
```bash
# View bot logs
docker-compose logs -f bot

# View MongoDB logs
docker-compose logs -f mongodb
```

### Validation Scripts
```bash
# Validate configuration
docker-compose exec bot npm run validate-config

# Run configuration migration
docker-compose exec bot npm run migrate-config
```

## 📚 Documentation

- **[SETTINGS.md](SETTINGS.md)**: Complete configuration reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**: Common issues and solutions
- **[.env.example](.env.example)**: Environment variable template

## 🤝 Contributing

### Development Workflow
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run quality checks: `npm run check`
5. Test with Docker Compose
6. Submit a pull request

### Code Standards
- Follow existing TypeScript patterns
- Add proper error handling
- Include comprehensive documentation
- Test your changes thoroughly
- Follow the established code style

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Discord.js Team**: Excellent Discord API library
- **MongoDB Team**: Robust database solution
- **Docker Team**: Containerization platform
- **Community Contributors**: Testing and feedback

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/your-repo/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-repo/discussions)
- **Documentation**: Check the docs folder and markdown files

---

**KoolBot** - Making Discord servers more engaging, one feature at a time! 🚀
