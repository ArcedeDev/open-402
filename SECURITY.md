# Security Policy

## Reporting a vulnerability

If you discover a security issue related to the Open 402 Directory, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

Instead, email us at:

**security@arcede.com**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

We will acknowledge your report within 48 hours and aim to resolve confirmed vulnerabilities within 7 days.

## Scope

The following are in scope for security reports:

### Registry data integrity

- A domain entry that serves malicious content (phishing, malware, credential harvesting)
- A domain entry that impersonates another service
- A manipulated `snapshot.json` that misrepresents a domain's actual `agent.json`
- Injection of entries that could cause harm when consumed by automated tools (e.g., XSS payloads in display names, SSRF-triggering URLs in endpoints)

### Infrastructure (if applicable)

- Vulnerabilities in the directory web application at `open402.directory`
- SSRF or injection via the domain submission endpoint
- Authentication bypass on the GitHub API integration
- Cache poisoning that causes incorrect data to be served

## Out of scope

- Vulnerabilities in individual API providers listed in the registry (report those to the provider)
- Social engineering attacks
- Denial of service attacks
- Issues in third-party services (GitHub, Vercel, etc.)

## Malicious domain reports

If you find a domain in the registry that is serving harmful content, you can:

1. **Email security@arcede.com** for urgent cases (phishing, active malware)
2. **Open an issue** using the "Report a domain" template for non-urgent cases (dead domains, incorrect metadata)

Malicious domains are removed from the registry within 24 hours of confirmation.

## Disclosure policy

- We practice coordinated disclosure
- We will credit reporters in our changelog (unless you prefer to remain anonymous)
- We do not currently offer a bug bounty program

## Supported versions

This is a data registry, not versioned software. Security reports apply to the current state of `main` branch and the live directory at `open402.directory`.
