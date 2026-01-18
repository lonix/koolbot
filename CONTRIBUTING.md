# Contributing to KoolBot

Thank you for your interest in contributing to KoolBot! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Quality Standards](#code-quality-standards)
- [Commit Message Conventions](#commit-message-conventions)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Documentation](#documentation)
- [Community](#community)

## Code of Conduct

This project adheres to a Code of Conduct. By participating, you are expected to uphold this code. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.

## Getting Started

### Prerequisites

- **Node.js** 18+ and npm
- **Docker** and Docker Compose (recommended for development)
- **MongoDB** (included in Docker setup)
- **Discord Bot Token** (from [Discord Developer Portal](https://discord.com/developers/applications))
- **Git** for version control

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:

   ```bash
   git clone https://github.com/YOUR_USERNAME/koolbot.git
   cd koolbot
   ```

3. Add the upstream repository:

   ```bash
   git remote add upstream https://github.com/lonix/koolbot.git
   ```

### Setup Development Environment

#### Option 1: Docker (Recommended)

```bash
# Copy environment file
cp .env.example .env

# Edit .env with your Discord bot credentials
# DISCORD_TOKEN, CLIENT_ID, GUILD_ID

# Start development environment
docker-compose -f docker-compose.dev.yml up
```

This provides hot reloading and automatic restarts on code changes.

#### Option 2: Local Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your Discord bot credentials and local MongoDB URI
# MONGODB_URI=mongodb://localhost:27017/koolbot

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

### Verify Setup

Once running, check that:

- The bot appears online in your Discord server
- Commands are registered (`/ping` should work)
- Logs show no errors

## Development Workflow

### Creating a Branch

Always create a new branch for your work:

```bash
# Update your main branch
git checkout main
git pull upstream main

# Create a feature branch
git checkout -b feature/your-feature-name

# Or for bug fixes
git checkout -b fix/bug-description
```

### Making Changes

1. **Write code** following the existing patterns and conventions
2. **Add tests** for new functionality (see [TESTING.md](TESTING.md))
3. **Update documentation** if you're changing user-facing features
4. **Run quality checks** frequently during development

### Testing Your Changes

```bash
# Run all tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

See [TESTING.md](TESTING.md) for detailed testing guidelines.

## Code Quality Standards

Before submitting a pull request, ensure your code passes all quality checks:

### Quick Quality Check

```bash
# Run all checks (build + lint + format + tests)
npm run check:all
```

### Individual Checks

```bash
# TypeScript compilation
npm run build

# Linting
npm run lint
npm run lint:fix  # Auto-fix issues

# Code formatting
npm run format         # Auto-format
npm run format:check   # Check only

# Markdown linting
npx markdownlint "**/*.md" --ignore node_modules --ignore dist
```

### Code Style Guidelines

- **TypeScript**: Use explicit types, avoid `any` where possible
- **Async/Await**: Prefer async/await over promise chains
- **Error Handling**: Always handle errors appropriately
- **Comments**: Add comments for complex logic; avoid obvious comments
- **Naming**: Use descriptive names (camelCase for variables/functions, PascalCase for classes)

### Testing Requirements

- **New Features**: Must include tests
- **Bug Fixes**: Add regression tests
- **Minimum Coverage**: Maintain at least the current coverage level
- **Test Location**: Place tests in `__tests__/` matching source structure

Example:

- Source: `src/commands/ping.ts`
- Test: `__tests__/commands/ping.test.ts`

### Docker Validation

If you modify dependencies or the build process:

```bash
# Test Docker build
docker-compose build

# Test Docker run
docker-compose up -d

# Check logs
docker-compose logs -f bot
```

## Commit Message Conventions

We follow conventional commit messages for clarity and automated changelog generation.

### Format

```text
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, no code change)
- **refactor**: Code refactoring (no functional change)
- **test**: Adding or updating tests
- **chore**: Maintenance tasks (dependencies, build config)
- **perf**: Performance improvements

### Examples

```bash
# Simple feature
git commit -m "feat(commands): add /quote search command"

# Bug fix with details
git commit -m "fix(voice): prevent duplicate channel creation

Fixes an issue where multiple channels could be created
if users joined the lobby simultaneously.

Closes #123"

# Documentation update
git commit -m "docs(readme): update installation instructions"

# Breaking change
git commit -m "feat(config)!: change voice tracking config structure

BREAKING CHANGE: Voice tracking configuration keys have been
restructured. Run the migration script to update."
```

### Scope

Common scopes in this project:

- `commands` - Slash commands
- `voice` - Voice channel features
- `config` - Configuration system
- `tracking` - Activity tracking
- `tests` - Test infrastructure
- `docker` - Docker/deployment
- `docs` - Documentation

## Pull Request Process

### Before Submitting

1. **Run all quality checks**: `npm run check:all`
2. **Test manually**: Verify your changes work in a real Discord server
3. **Update documentation**: Add/update relevant docs
4. **Write clear commit messages**: Follow commit conventions
5. **Rebase if needed**: Keep your branch up to date with main

```bash
git fetch upstream
git rebase upstream/main
```

### Creating a Pull Request

1. **Push your branch** to your fork:

   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request** on GitHub
3. **Fill out the PR template** completely
4. **Link related issues**: Use "Closes #123" or "Fixes #456"
5. **Add labels**: The bot will auto-label based on changed files

### PR Checklist

Your PR should include:

- [ ] Clear description of changes
- [ ] Link to related issue(s)
- [ ] Tests for new functionality
- [ ] Documentation updates (if applicable)
- [ ] All CI checks passing
- [ ] No merge conflicts
- [ ] Code follows project conventions

### Review Process

- Maintainers will review your PR and may request changes
- Address feedback by pushing new commits to your branch
- Once approved, a maintainer will merge your PR
- Your changes will be included in the next release

### PR Labels

Labels are automatically applied based on changed files:

- `feature`, `enhancement` - New features
- `bug`, `fix` - Bug fixes
- `documentation` - Documentation changes
- `dependencies` - Dependency updates
- `test` - Test changes
- `docker` - Docker-related changes
- `github-actions` - CI/CD workflow changes

You can also manually add version labels:

- `major` or `breaking` - Breaking changes (v1.0.0 → v2.0.0)
- `minor` or `feature` - New features (v1.0.0 → v1.1.0)
- `patch` or `fix` - Bug fixes (v1.0.0 → v1.0.1)

## Issue Reporting

### Before Creating an Issue

1. **Search existing issues** to avoid duplicates
2. **Check documentation** ([README.md](README.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md))
3. **Verify you're using the latest version**
4. **Test with minimal configuration** to isolate the problem

### Creating a Good Issue

Use the appropriate issue template:

- **Bug Report**: For reporting bugs or unexpected behavior
- **Feature Request**: For suggesting new features
- **Documentation**: For documentation improvements
- **Question**: For support questions (consider Discussions first)

Include:

- Clear, descriptive title
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Environment details (OS, Node.js version, Discord.js version)
- Relevant logs or error messages
- Configuration (sanitize sensitive data)

### Issue Labels

Issues are automatically labeled based on content and file changes:

- `bug` - Something isn't working
- `enhancement` - New feature or improvement
- `documentation` - Documentation related
- `question` - Further information requested
- `good first issue` - Good for newcomers
- `help wanted` - Extra attention needed

## Documentation

### What to Document

Document changes if you:

- Add or modify commands
- Change configuration options
- Add new features
- Change setup/deployment process
- Fix common issues

### Documentation Files

- **README.md**: Quick start, features, basic usage
- **COMMANDS.md**: Complete command reference
- **SETTINGS.md**: Configuration options
- **TESTING.md**: Testing guidelines
- **TROUBLESHOOTING.md**: Common issues and solutions

### Markdown Standards

- **Max line length**: 160 characters (except code blocks and tables)
- **Code blocks**: Use fenced code blocks with language identifiers
- **Links**: Use descriptive link text
- **Headings**: Follow hierarchical structure (H1 → H2 → H3)

Validate markdown:

```bash
npx markdownlint "**/*.md" --ignore node_modules --ignore dist
```

## Community

### Getting Help

- **GitHub Discussions**: For questions and general discussion
- **GitHub Issues**: For bug reports and feature requests
- **Pull Requests**: For code contributions

### Communication Guidelines

- Be respectful and constructive
- Provide context and details
- Stay on topic
- Follow the Code of Conduct
- Help others when you can

### Recognition

All contributors are recognized in release notes and the project's commit history. Significant contributions may be highlighted in changelogs.

## Additional Resources

- [README.md](README.md) - Project overview and quick start
- [TESTING.md](TESTING.md) - Testing guide
- [COMMANDS.md](COMMANDS.md) - Command reference
- [SETTINGS.md](SETTINGS.md) - Configuration reference
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues
- [Code of Conduct](CODE_OF_CONDUCT.md) - Community guidelines

## Questions?

If you have questions about contributing:

- Check the documentation
- Search [GitHub Discussions](https://github.com/lonix/koolbot/discussions)
- Ask in a new discussion
- Open an issue if you've found a bug

Thank you for contributing to KoolBot! 🚀
