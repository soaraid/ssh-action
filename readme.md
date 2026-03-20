# SSH Config Setup Action

Securely configure SSH access in GitHub Actions from a private key, then remove the generated credentials during the post-job phase.

This project is a Node.js-based GitHub Action built with TypeScript for teams that want a clean SSH setup step without embedding shell-heavy setup logic into every workflow.

## Features

- Supports base64-encoded and raw PEM/OpenSSH private keys without shell decoding
- Strict file permissions for `~/.ssh`, the generated private key, and `~/.ssh/config`
- Cross-platform path handling using `os.homedir()` and `path.join()`
- Post-job cleanup that removes the generated private key and the managed SSH config block
- Secret masking via `@actions/core.setSecret`
- Simple SSH alias usage for later steps such as `ssh`, `scp`, and `rsync`

## Inputs

| Input | Description | Required | Default |
| :-- | :-- | :--: | :-- |
| `key` | SSH private key in base64-encoded or raw PEM/OpenSSH format. | Yes | - |
| `username` | SSH username for the remote server. | Yes | - |
| `host` | SSH host domain or IP address. | Yes | - |
| `port` | SSH port to connect through. | No | `22` |
| `key_file_name` | Name of the generated private key file. | No | `key.pem` |
| `alias` | Alias to use in subsequent steps. | No | `ssh-host` |

## Usage

```yaml
name: Deploy

on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure SSH
        uses: ./
        with:
          key: ${{ secrets.SSH_PRIVATE_KEY_BASE64 }}
          username: deploy
          host: example.com
          port: "22"
          alias: production
          key_file_name: key.pem

      - name: Test SSH connectivity
        run: ssh production "echo 'Connected!'"
```

After the setup step completes, subsequent steps can use the configured alias directly:

```bash
ssh production
scp ./build.tar.gz production:/var/www/releases/
rsync -avz ./dist/ production:/var/www/app/
```

## What The Action Does

During the main phase, the action:

1. Reads the private key from the `key` input.
2. If needed, decodes it in memory using Node.js.
3. Creates `~/.ssh` with `0o700` permissions.
4. Writes the private key and `~/.ssh/config` with `0o600` permissions.
5. Appends a managed SSH config block for the requested alias.
6. Saves state so the post-job cleanup step can remove the generated artifacts.

During the post phase, the action:

1. Performs a best-effort overwrite and deletion of the generated private key file.
2. Removes the SSH config block created by this action.

## Security Notes

- The private key is never decoded with shell commands.
- The action accepts either raw PEM/OpenSSH key material or a base64-encoded version of that key.
- The action uses `core.setSecret()` to mask the base64 input and decoded key material in logs.
- The generated `~/.ssh` directory is forced to `0o700`.
- The generated private key file and `~/.ssh/config` are forced to `0o600`.
- The action currently writes `StrictHostKeyChecking no` for convenience. This reduces connection friction, but it also weakens host authenticity verification. Use it only when that tradeoff is acceptable for your environment.
- The post-job cleanup is especially important for self-hosted runners, where leftover credentials would otherwise persist across jobs.

## Generate A Base64 Key

macOS and Linux:

```bash
base64 -i ~/.ssh/id_rsa
```

If your environment produces wrapped output, convert it to a single line before saving it as a GitHub secret.

## Build

Install dependencies and compile the action bundles with `ncc`:

```bash
npm install
npm run build
```

This generates:

- `dist/index.js`
- `dist/cleanup.js`

## Project Structure

```text
action.yml
src/main.ts
src/cleanup.ts
package.json
tsconfig.json
```

## Development Notes

- Runtime: `node20`
- Language: TypeScript
- Core packages: `@actions/core`, `@actions/io`, `@actions/exec`
- Bundler: `@vercel/ncc`

## License

MIT
