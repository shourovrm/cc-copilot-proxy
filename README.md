# cc-copilot-proxy

Local OpenAI-compatible proxy for Command Code's `/alpha/generate` endpoint.
Lets GitHub Copilot CLI and VS Code use your **Go plan**.

## Quick start

```sh
# Terminal 1 — start proxy
cd ~/repos/cc-copilot-proxy
node proxy.mjs

# Terminal 2 — Copilot CLI
export COPILOT_PROVIDER_BASE_URL="http://127.0.0.1:5959"
export COPILOT_MODEL="deepseek/deepseek-v4-flash"
copilot
```

## VS Code setup

The proxy also serves as a custom endpoint for VS Code Copilot BYOK
(Insiders only). The config lives at:

```
~/.config/Code - Insiders/User/chatLanguageModels.json
```

After `Developer: Reload Window`, models appear in the Copilot Chat dropdown
under the **Command Code** group.

## Check available models

```sh
curl -s http://127.0.0.1:5959/v1/models | python3 -c \
  "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data']]"
```

## Add a new model

### VS Code
Edit `chatLanguageModels.json`, add an entry to the `models` array:

```json
{
  "id": "provider/model-id",
  "name": "Display Name",
  "url": "http://127.0.0.1:5959/v1/chat/completions",
  "toolCalling": true,
  "vision": false,
  "maxInputTokens": 200000,
  "maxOutputTokens": 64000
}
```

`Ctrl+Shift+P` → `Developer: Reload Window`.

### Copilot CLI
Just change the env var:

```sh
export COPILOT_MODEL="provider/model-id"
copilot
```

## Change API key

One place: `~/.commandcode/auth.json`. Replace the `apiKey` value.
Restart the proxy. VS Code config never needs the real key —
`proxy-handles-auth` is a placeholder.

```json
{
  "apiKey": "user_YOUR_NEW_KEY"
}
```

## Switch to a different provider

### Copilot CLI
Change `COPILOT_PROVIDER_BASE_URL`:

```sh
export COPILOT_PROVIDER_BASE_URL="https://api.openai.com/v1"
export COPILOT_MODEL="gpt-4o"
export COPILOT_PROVIDER_API_KEY="sk-..."
copilot
```

### VS Code
Edit `chatLanguageModels.json` — change `url` and `apiKey` per model/provider.

## Remove the proxy (upgrade to Provider plan)

If you upgrade to Command Code's Provider plan ($15/mo):

**VS Code**: change `url` to `https://api.commandcode.ai/provider/v1/chat/completions`
and set `apiKey` to your real key.

**Copilot CLI**:
```sh
export COPILOT_PROVIDER_BASE_URL="https://api.commandcode.ai/provider/v1"
export COPILOT_PROVIDER_API_KEY="user_..."
export COPILOT_MODEL="deepseek/deepseek-v4-flash"
copilot
```

No proxy needed.

## Env vars

| Variable | Default | Description |
|---|---|---|
| `CC_PROXY_PORT` | `5959` | Proxy listen port |
| `CC_PROXY_DEBUG` | `0` | Set to `1` for request logging |
| `COMMANDCODE_API_KEY` | (reads auth file) | Override API key from env |
