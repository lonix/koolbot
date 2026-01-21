# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

The KoolBot team takes security bugs seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

1. **GitHub Security Advisories** (Preferred):
   - Go to the [Security Advisories](https://github.com/lonix/koolbot/security/advisories) page
   - Click "Report a vulnerability"
   - Fill in the details of the vulnerability

2. **Direct Email**:
   - Email the maintainers directly through GitHub
   - Include "[SECURITY]" in the subject line

### What to Include

Please include the following information in your report to help us better understand the issue:

- **Type of issue** (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- **Full paths of source file(s)** related to the manifestation of the issue
- **Location of the affected source code** (tag/branch/commit or direct URL)
- **Any special configuration** required to reproduce the issue
- **Step-by-step instructions** to reproduce the issue
- **Proof-of-concept or exploit code** (if possible)
- **Impact of the issue**, including how an attacker might exploit it

### Response Timeline

- **Initial Response**: Within 48 hours, we will acknowledge receipt of your vulnerability report
- **Status Update**: Within 7 days, we will provide a detailed response with:
  - Confirmation or rejection of the vulnerability
  - Our assessment of severity
  - Planned fix timeline
- **Resolution**: We aim to release a fix within 30 days for critical vulnerabilities

### Disclosure Policy

- We request that you give us reasonable time to fix the issue before public disclosure
- We will credit you in the release notes unless you prefer to remain anonymous
- We will publish a security advisory once a fix is available
- Please coordinate disclosure timing with us

## Security Best Practices for Users

### Bot Token Security

- **Never commit** your Discord bot token to version control
- **Use environment variables** for all sensitive credentials
- **Rotate tokens** if you suspect they have been compromised
- **Restrict bot permissions** to only what is needed

### Configuration Security

- **Review configuration** before enabling features
- **Limit admin access** to trusted users only
- **Use role-based permissions** for sensitive commands
- **Monitor bot logs** for suspicious activity

### Docker Security

- **Keep images updated**: Regularly pull the latest Docker image
- **Review environment variables**: Ensure only necessary variables are exposed
- **Network isolation**: Use Docker networks to isolate the bot
- **Volume permissions**: Set appropriate permissions for mounted volumes

### MongoDB Security

- **Use authentication**: Always enable MongoDB authentication in production
- **Network isolation**: Don't expose MongoDB to the internet
- **Regular backups**: Implement a backup strategy
- **Monitor access**: Review MongoDB logs regularly

## Known Security Considerations

### Rate Limiting

KoolBot includes built-in rate limiting to prevent command spam. Ensure rate limiting is enabled in production:

```bash
/config set key:ratelimit.enabled value:true
```

### Input Validation

All user inputs are validated and sanitized. Report any instances where user input is not properly validated.

### Discord Permissions

Review bot permissions carefully:

- **Required**: `SendMessages`, `UseSlashCommands`
- **Voice features**: `ManageChannels`, `MoveMembers`
- **Avoid**: `Administrator` (use specific permissions instead)

### Data Privacy

- **Personal data**: KoolBot stores user IDs and voice activity data
- **Data retention**: Configure cleanup policies to minimize data storage
- **Data access**: Only bot administrators can access stored data
- **GDPR compliance**: Users can request data deletion via bot administrators

## Security Updates

Security updates will be released as patch versions and announced via:

- **GitHub Security Advisories**
- **Release notes** with `[SECURITY]` prefix
- **GitHub Releases** page

## Questions?

If you have questions about this security policy, please open a discussion on GitHub or contact the maintainers.

## Recognition

We appreciate responsible disclosure and will acknowledge security researchers who report vulnerabilities:

- Credit in release notes (unless anonymity is requested)
- Recognition in our security hall of fame
- Public thanks in security advisories

Thank you for helping keep KoolBot and its users safe!
