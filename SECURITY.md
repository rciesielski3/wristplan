# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (private vulnerability reporting / security advisories). Do not open a
public issue or pull request for a suspected vulnerability.

Include the affected version or commit, reproduction steps and the impact. Expect an acknowledgement
on a best-effort basis.

## Scope

In scope: code in this repository, including handling of intervals.icu and Garmin credentials,
the ownership guard that protects non-app events, and dependency or CI configuration issues.

Out of scope: vulnerabilities in intervals.icu, Garmin Connect or other third-party services
(report those to the vendor), and issues requiring a compromised local machine.

## Secrets

Never include API keys, tokens, `.env` contents or personal activity data in issues, pull requests,
logs or screenshots. If a key was exposed, revoke and rotate it immediately.
