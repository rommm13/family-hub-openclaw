# Security

Family Hub handles family data, Telegram routing and calendar synchronization. Runtime data must remain outside source control.

Never commit Telegram bot tokens, OAuth credentials, API keys, cookies, production databases or backups, real Telegram/chat IDs, calendar IDs, server addresses, account identifiers, private media libraries, live OpenClaw configuration, or personal family records.

Before release, run an automated secret scan and manually inspect the complete export tree. Report vulnerabilities privately to the repository owner; do not post sensitive details in a public issue.
