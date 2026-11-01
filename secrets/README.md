# Credentials Vault

Encrypted backup of `.env.credentials` (AES-256-CBC + PBKDF2). This file is
safe to keep in the repo — it is unreadable without the passphrase.

## Why this exists
The sandbox disk is ephemeral and has wiped plaintext credentials 4 times.
This vault (in Git history on GitHub) is the ONLY copy that survives a full
disk rollback.

## To restore after a wipe
```bash
openssl enc -aes-256-cbc -pbkdf2 -a -d \
  -in secrets/vault.enc \
  -pass pass:'<VAULT_PASSPHRASE>' > .env.credentials
chmod 600 .env.credentials
```

The passphrase is stored in `~/.mycloudy-credentials` (VAULT_PASSPHRASE line)
and was communicated to the repo owner in chat.

## To update the vault
```bash
source .env.credentials 2>/dev/null
openssl enc -aes-256-cbc -pbkdf2 -a -salt \
  -in .env.credentials -out secrets/vault.enc \
  -pass pass:"$VAULT_PASSPHRASE"
git add secrets/vault.enc && git commit -m "chore(vault): refresh credentials"
```
