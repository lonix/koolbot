#!/bin/bash

# Bot Registration Validation Script
# This script validates that the bot is properly registered with Discord

set -e

echo "🤖 KoolBot Registration Validation"
echo "=================================="

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    echo "Please create a .env file with your bot credentials:"
    echo ""
    echo "DISCORD_TOKEN=your_bot_token_here"
    echo "CLIENT_ID=your_client_id_here"
    echo "GUILD_ID=your_guild_id_here"
    echo "MONGODB_URI=mongodb://localhost:27017/koolbot"
    echo "DEBUG=true"
    echo "NODE_ENV=development"
    echo ""
    exit 1
fi

echo "✅ .env file found"

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed or not in PATH"
    exit 1
fi

echo "✅ Node.js is available"

# Check if TypeScript is compiled
if [ ! -d "dist" ]; then
    echo "📦 Building TypeScript..."
    npm run build
fi

echo "✅ TypeScript is compiled"

# Run the validation script
echo ""
echo "🔍 Running bot registration validation..."
echo "========================================"

node dist/scripts/validate-bot-registration.js

echo ""
echo "🎉 Validation complete!"
echo ""
echo "📝 If validation was successful:"
echo "  1. Your bot should now be properly registered with Discord"
echo "  2. Commands should be available in your Discord server"
echo "  3. You can test commands like /ping and /botstats"
echo ""
echo "🔧 If validation failed:"
echo "  1. Check your .env file has correct credentials"
echo "  2. Ensure your bot has proper permissions"
echo "  3. Verify your bot token is valid"
echo "  4. Check the error messages above for specific issues"
