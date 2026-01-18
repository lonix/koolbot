## Description

<!-- Provide a clear and concise description of your changes -->

## Type of Change

<!-- Mark the relevant option with an "x" -->

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] 📚 Documentation update
- [ ] ♻️ Code refactoring (no functional changes)
- [ ] 🧪 Test updates
- [ ] 🔧 Build/tooling changes
- [ ] ⚡ Performance improvement

## Related Issues

<!-- Link to related issues using keywords: Fixes #123, Closes #456, Refs #789 -->

Fixes #

## How Has This Been Tested?

<!-- Describe the tests you ran to verify your changes -->

- [ ] Existing tests pass (`npm test`)
- [ ] Added new tests for new functionality
- [ ] Manually tested in development environment
- [ ] Tested in Docker environment

**Test Configuration**:

- Node.js version:
- Discord.js version:
- Operating System:

## Checklist

<!-- Mark completed items with an "x" -->

### Code Quality

- [ ] My code follows the project's coding standards
- [ ] I have run `npm run check:all` and all checks pass
- [ ] I have run `npm run lint` and fixed any issues
- [ ] I have run `npm run format` to format my code
- [ ] I have performed a self-review of my own code
- [ ] My changes generate no new warnings or errors

### Testing

- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] I have tested my changes manually

### Documentation

- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have updated the documentation where necessary:
  - [ ] `COMMANDS.md` (if adding/modifying commands)
  - [ ] `SETTINGS.md` (if adding/modifying configuration)
  - [ ] `README.md` (if adding user-facing features)
  - [ ] Inline code comments for complex logic
- [ ] I have validated markdown with `npx markdownlint "**/*.md" --ignore node_modules --ignore dist`

### Dependencies & Docker

- [ ] I have updated `Dockerfile` if dependencies changed
- [ ] I have updated `Dockerfile.dev` if dev dependencies changed
- [ ] I have tested the Docker build (`docker-compose build`)
- [ ] I have run security checks if adding new dependencies

### Configuration (if applicable)

- [ ] New features are disabled by default and toggleable via configuration
- [ ] I have added configuration schema entries in `config-schema.ts`
- [ ] I have documented new configuration keys in `SETTINGS.md`
- [ ] I have tested configuration reload (`/config reload`)

## Screenshots (if applicable)

<!-- Add screenshots for UI changes or visual features -->

## Additional Notes

<!-- Any additional information, context, or notes for reviewers -->

## Pre-Submission Verification

<!-- Final checks before submitting - DO NOT SKIP -->

- [ ] I have rebased my branch on the latest main branch
- [ ] I have resolved any merge conflicts
- [ ] I have reviewed the diff of all my changes
- [ ] All automated CI checks are expected to pass
- [ ] I am ready for code review

---

**By submitting this pull request, I confirm that my contribution is made under the terms of the project's license.**
