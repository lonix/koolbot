# KoolBot Troubleshooting Guide

## Settings Migration Issues (v0.3.1 → v0.4.0)

### Critical Issues Identified

#### 1. **Missing MONGODB_URI**
**Problem**: The `.env` file is missing the `MONGODB_URI` variable.
**Impact**: 
- Voice channel tracking data cannot be stored
- Configuration changes cannot be persisted
- Bot may crash on startup
- All database operations fail

**Solution**: Add to your `.env` file:
```env
MONGODB_URI=mongodb://localhost:27017/koolbot
# Or for production:
MONGODB_URI=mongodb://username:password@host:port/database
```

#### 2. **Configuration Key Mismatches**
**Problem**: The bot is trying to read both old environment variable names and new database configuration keys.
**Impact**:
- Dynamic channel creation fails
- Voice channel stats tracking breaks
- Inconsistent behavior

**Solution**: Run the configuration migration script:
```bash
npm run migrate-config
```

#### 3. **Voice Channel Management Failures**
**Problem**: Configuration service cannot properly determine if features are enabled.
**Impact**:
- No dynamic channels created
- Lobby channel doesn't work
- Channel cleanup fails

**Solution**: Ensure these settings are properly configured:
```env
ENABLE_VC_MANAGEMENT=true
VC_CATEGORY_NAME=Voice Channels
LOBBY_CHANNEL_NAME=🟢  Lobby
LOBBY_CHANNEL_NAME_OFFLINE=🔴  Lobby
```

### Step-by-Step Fix Process

#### Step 1: Fix Environment Variables
1. **Add missing MONGODB_URI**:
   ```env
   MONGODB_URI=mongodb://localhost:27017/koolbot
   ```

2. **Verify all required variables**:
   ```env
   DISCORD_TOKEN=your_bot_token
   CLIENT_ID=your_client_id
   GUILD_ID=your_guild_id
   MONGODB_URI=mongodb://localhost:27017/koolbot
   DEBUG=false
   NODE_ENV=production
   ```

#### Step 2: Run Configuration Migration
```bash
# Build the project first
npm run build

# Run the migration script
npm run migrate-config
```

This will:
- Migrate old environment variables to new database configuration
- Set up proper configuration categories
- Ensure backward compatibility

#### Step 3: Validate Configuration
```bash
npm run validate-config
```

This will:
- Check all required configurations
- Identify any remaining issues
- Provide detailed status report

#### Step 4: Test the Bot
1. **Start the bot**:
   ```bash
   npm run dev
   ```

2. **Check logs** for:
   - Configuration loading success
   - Voice channel manager initialization
   - Voice channel tracker initialization
   - Channel creation success

### Common Error Messages and Solutions

#### "MongoDB connection timeout"
**Cause**: Missing or incorrect MONGODB_URI
**Solution**: Add correct MONGODB_URI to .env file

#### "Category not found during initialization"
**Cause**: VC_CATEGORY_NAME mismatch or category doesn't exist
**Solution**: 
1. Check VC_CATEGORY_NAME in .env
2. Ensure the category exists in Discord
3. Run `npm run migrate-config`

#### "Voice channel management is disabled"
**Cause**: ENABLE_VC_MANAGEMENT is false or not set
**Solution**: Set `ENABLE_VC_MANAGEMENT=true` in .env

#### "No member found in voice state update"
**Cause**: Discord.js event handling issue
**Solution**: This is usually a transient issue, check if it persists

### Testing Dynamic Channel Creation

1. **Join the lobby channel** (🟢 Lobby)
2. **Check if a new channel is created** for your user
3. **Verify channel naming** follows the pattern: `Username's Room`
4. **Test channel cleanup** by leaving the channel

### Testing Voice Channel Stats

1. **Join any voice channel**
2. **Stay for a few minutes**
3. **Check if tracking data is saved** (use `/vcstats` command)
4. **Verify weekly announcements** are working

### Monitoring and Debugging

#### Enable Debug Mode
```env
DEBUG=true
```

#### Check Logs
The bot will now provide detailed logging for:
- Configuration loading
- Voice channel operations
- Database operations
- Error conditions

#### Database Verification
Check if data is being stored:
```bash
# Connect to MongoDB
mongosh mongodb://localhost:27017/koolbot

# Check collections
show collections

# Check voice sessions
db.voicesessions.find().limit(5)

# Check configuration
db.configs.find()
```

### Rollback Plan

If issues persist, you can temporarily rollback to the old configuration system by:

1. **Comment out the migration** in the config service
2. **Use only environment variables** for configuration
3. **Restart the bot**

### Support

If you continue to experience issues:

1. **Check the logs** for specific error messages
2. **Run validation scripts** to identify problems
3. **Verify database connectivity**
4. **Check Discord permissions** for the bot

### Prevention for Future Updates

1. **Always test configuration changes** in development first
2. **Use the validation scripts** before deploying
3. **Keep environment variables** for critical settings
4. **Monitor logs** after configuration changes
