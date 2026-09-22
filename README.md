# cc-copilot-proxy

Local OpenAI-compatible proxy for Command Code's `/alpha/generate` endpoint.
Lets GitHub Copilot CLI and VS Code use your **Go plan**.

## Quick start

```sh
# clone the repo
cd ~/repos
git clone https://github.com/shourovrm/cc-copilot-proxy
# start proxy
cd cc-copilot-proxy
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

## Automatic model list

The proxy keeps the **Command Code** group of that file in sync with the
models your plan can use. VS Code reads the file only when a window loads, so
after the proxy prints `VS Code model list updated`, run
`Developer: Reload Window`.

On every start, and every 5 minutes after, the proxy:

1. Fetches Command Code's model list (no tokens).
2. Sends each model it has not tested before one `hi` message capped at a
   16-token reply, about 20 tokens per model. A first run over ~75 models costs
   roughly 1,500 tokens and takes a few minutes in the background; later
   starts test only models Command Code has added since.
3. Adds models that answer, removes models that fail or that Command Code no
   longer lists, and leaves every other group in the file untouched. The
   previous file is saved as `chatLanguageModels.json.bak`.

Test results are stored in `~/.config/cc-copilot-proxy/model-checks.json`.
A model that fails only for a temporary reason (network error, rate limit,
server error) is not recorded and is tested again on the next start.

An account with no credits gets `insufficient credits` for every model. In
that case the proxy records nothing and leaves the VS Code file unchanged, so
an expired plan does not empty your model list.

Entries already in the file are kept as written, so hand-edited values such as
`"vision": true` survive syncing. New entries get `toolCalling: true`,
`vision: false`, `maxInputTokens` set to the model's context length, and
`maxOutputTokens: 64000`.

After changing plans, test every model again:

```sh
node proxy.mjs --recheck
```

## Check available models

```sh
curl -s http://127.0.0.1:5959/v1/models | python3 -c \
  "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data']]"
```

## Add a new model

### VS Code
New models on your plan are added automatically (see
[Automatic model list](#automatic-model-list)). To add one by hand, or to
override its settings, edit `chatLanguageModels.json` and add an entry to the
`models` array:

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
| `CC_PROXY_VSCODE_MODELS_FILE` | VS Code Insiders `User/chatLanguageModels.json` | File the model list is synced into |
